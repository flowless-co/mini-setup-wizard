/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Build a Flowless content-setup fixture from a small domain input.
 *
 * Key changes in this refactor:
 *  - No `{ from: "metric", index: N }` anywhere. We now pass **metric IDs** directly,
 *    or use **metrics_calcs** to reference prior calculator outputs (by their calc metric_id UUID).
 *  - NDF + Leak match the expected style: Leak trigger has a first calc (FAVED_LEAKAGE_VOLUME),
 *    then a monthly SUM calc; NDF references that **previous calc metric_id** for `leakage_sum`.
 *  - AZP source selection: if any pressure sensor has `AZP: true`, that sensor is the sole input
 *    for AZP in this zone. Otherwise we fall back to the first pressure sensor (or PS-1 seed).
 */

export type BuildOptions = {
  indent?: number;
  fullZoneSuite?: boolean;
  keepExisting?: boolean;
};

type FixtureItem = {
  model: string;
  pk: string | number;
  fields: any;
};

const MODEL = {
  POLYGON: "fl_monitoring.polygon",
  POINT: "fl_monitoring.point",
  LINK: "fl_monitoring.link",
  METRIC: "fl_monitoring.metricdefinition",
  TRIGGER: "fl_dispatcher.metrictrigger",
} as const;

const CATEGORY = {
  ZONE: "zone",
  FLOW_METER: "flow_meter",
  PRESSURE_SENSOR: "pressure_sensor",

  FLOW_READING: "flow_reading",
  PRESSURE_READING: "pressure_reading",
  FLOW_VOLUME: "flow_volume",
  ZONE_DEMAND: "zone_demand",
  AVG_ZONE_PRESSURE: "average_zone_pressure",
  AVG_ZONE_PRESSURE_VAR: "average_zone_pressure_variance",
  DEMAND_VAR: "demand_variance",
  ZONE_LEAK: "zone_leak",
  UARL: "uarl",
  UBL: "ubl",
  ILI: "ili",
  ICF: "icf",
  NDF: "ndf",
  MAX_REC_LEAK: "max_recoverable_leak",
  CONSUMPTION: "consumption",
  REAL_LOSSES: "real_losses",
  PRESSURE: "pressure",
  MNF: "minimum_night_flow",
  PMNF: "pressure_at_minimum_night_flow",
} as const;

const INTERVAL = {
  QH: "QUARTER_HOUR",
  HOURLY: "HOURLY",
  DAILY: "DAILY",
  MONTHLY: "MONTHLY",
} as const;

const SOURCE = { SENSOR: "SENSOR", FORMULA: "FORMULA" } as const;
const DATA_TYPE = { ANALOG: "ANALOG" } as const;

type StrSet = { [k: string]: true };

function isFixtureArray(x: any): x is FixtureItem[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    typeof x[0] === "object" &&
    "model" in x[0] &&
    "fields" in x[0]
  );
}

function safeJson(x: any) {
  try {
    return JSON.stringify(x);
  } catch {
    return "[]";
  }
}

function asCoordString(coord: number[] | number[][] | number[][][]) {
  return JSON.stringify(coord, null, 2);
}

/** Strict ID registry: unique string IDs + one global counter for all numeric PKs */
class IdRegistry {
  private usedText: StrSet = {};
  private maxNumericPk = 0;

  constructor(existing: FixtureItem[] = []) {
    for (const it of existing) {
      const f = it.fields || {};
      if (typeof it.pk === "string") this.usedText[it.pk] = true;
      if (typeof f.id === "string") this.usedText[f.id] = true;

      if (typeof it.pk === "number" && Number.isFinite(it.pk)) {
        this.maxNumericPk = Math.max(this.maxNumericPk, it.pk);
      }
      if (typeof f.id === "number" && Number.isFinite(f.id)) {
        this.maxNumericPk = Math.max(this.maxNumericPk, f.id);
      }
    }
  }

  make(prefix: "pl" | "p" | "m" | "t"): string {
    let id = "";
    do {
      const now = Date.now().toString(36);
      const rnd = Math.random().toString(36).slice(2, 8);
      id = `${prefix}-${(now + rnd).slice(0, 12)}`;
    } while (this.usedText[id]);
    this.usedText[id] = true;
    return id;
  }

  nextNumPk(): number {
    this.maxNumericPk += 1;
    return this.maxNumericPk;
  }

  reserve(id: string) {
    this.usedText[id] = true;
  }

  ensureUnique(id: string, prefix: "pl" | "p" | "m" | "t"): string {
    if (!this.usedText[id]) {
      this.usedText[id] = true;
      return id;
    }
    return this.make(prefix);
  }
}

function pushItem(
  out: FixtureItem[],
  model: string,
  pk: string | number,
  fields: any
) {
  out.push({ model, pk, fields });
}

function findByLabel(items: FixtureItem[], model: string, label: string) {
  return items.find((x) => x.model === model && x.fields?.label === label);
}

/** Build a metric definition, returning its id */
function addMetric(
  out: FixtureItem[],
  ids: IdRegistry,
  label: string,
  category: string,
  unit: string,
  targetId: string,
  interval: string,
  tags: string[] = [],
  source: string = SOURCE.FORMULA,
  storageTable = 68,
  args: any = {}
): string {
  const mId = ids.make("m");
  pushItem(out, MODEL.METRIC, mId, {
    id: mId,
    label,
    category,
    unit,
    interval,
    tags_list: safeJson(tags),
    target_id: targetId,
    storage_table: storageTable,
    args: Object.keys(args || {}).length
      ? args
      : source === SOURCE.FORMULA
      ? {}
      : null,
    tags: "",
    factor: "1.00000000",
    offset: "0E-8",
    source,
    data_type: DATA_TYPE.ANALOG,
    describes: interval,
    value_range: "[]",
    is_optimized: false,
    aggregation_type: "gauge",
    pulse_round_down: false,
    histogram_interval:
      interval === INTERVAL.QH ? { days: 0, hours: 0, minutes: 0 } : null,
  });
  return mId;
}

/** Add a trigger with calculators; optionally write triggerinputmetrics rows */
function addTrigger(
  out: FixtureItem[],
  ids: IdRegistry,
  desc: string,
  inputMetrics: string[],
  outputMetric: string,
  calculators: any[]
) {
  // Ensure unique output_metric across triggers
  const conflict = out.find(
    (x) => x.model === MODEL.TRIGGER && x.fields?.output_metric === outputMetric
  );
  if (conflict) {
    const fixed = ids.make("m");
    const metric = out.find(
      (x) => x.model === MODEL.METRIC && x.pk === outputMetric
    );
    if (metric) {
      metric.pk = fixed;
      (metric as any).fields.id = fixed;
    }
    outputMetric = fixed;
  }

  // Normalize calculators: ensure calc_args exists and has time_range_type="operation"
  const normalizedCalculators = (
    Array.isArray(calculators) ? calculators : []
  ).map((c) => {
    const calc = c ? { ...c } : {};
    const args =
      calc && typeof calc.calc_args === "object" && calc.calc_args !== null
        ? { ...calc.calc_args }
        : {};
    if (args.time_range_type == null) args.time_range_type = "operation";
    calc.calc_args = args;
    return calc;
  });

  const tId = ids.make("t");
  pushItem(out, MODEL.TRIGGER, tId, {
    id: tId,
    caller: "REAL_TIME",
    is_active: true,
    calculator: "",
    calculators: normalizedCalculators,
    description: desc,
    schedule_job: "",
    input_metrics: inputMetrics,
    output_metric: outputMetric,
  });
}

/** Main builder */
export function buildFixtureJson(
  input: any,
  indent: number = 2,
  options: BuildOptions = {}
): string {
  const { fullZoneSuite = true, keepExisting = true } = options;

  const existing: FixtureItem[] =
    isFixtureArray(input) && keepExisting ? input.slice() : [];
  const out: FixtureItem[] = existing.slice();
  const ids = new IdRegistry(existing);

  // Seed domain defaults
  let zoneLabel = "Zone A";
  let zonePolygon: number[][][] = [
    [
      [35.0, 31.6],
      [35.01, 31.6],
      [35.01, 31.61],
      [35.0, 31.61],
      [35.0, 31.6],
    ],
  ];

  type MeterSeed = {
    kind: "flow_meter" | "pressure_sensor";
    label: string;
    coord: [number, number];
    AZP?: boolean;
  };
  const meters: MeterSeed[] = [
    { kind: "flow_meter", label: "FM-1", coord: [35.005, 31.605] },
    { kind: "flow_meter", label: "FM-2-preexisting", coord: [35.004, 31.606] },
    { kind: "pressure_sensor", label: "PS-1", coord: [35.006, 31.606] },
  ];

  // If input is domain-ish object, take values
  if (!isFixtureArray(input) && input && typeof input === "object") {
    if (input.zone?.label) zoneLabel = String(input.zone.label);
    if (Array.isArray(input.zone?.polygon)) zonePolygon = input.zone.polygon;
    if (Array.isArray(input.meters)) {
      const userMeters: MeterSeed[] = [];
      input.meters.forEach((m: any) => {
        if (!m || !m.kind || !m.label || !m.coord) return;
        userMeters.push({
          kind: m.kind,
          label: String(m.label),
          coord: m.coord,
          AZP: !!m.AZP,
        });
      });
      if (userMeters.length) {
        const hasFM = userMeters.some((m) => m.kind === "flow_meter");
        const hasPS = userMeters.some((m) => m.kind === "pressure_sensor");
        meters.splice(0, meters.length, ...userMeters);
        if (!hasFM)
          meters.push({
            kind: "flow_meter",
            label: "FM-1",
            coord: [35.005, 31.605],
          });
        if (!hasPS)
          meters.push({
            kind: "pressure_sensor",
            label: "PS-1",
            coord: [35.006, 31.606],
          });
      }
    }
  }

  // Zone
  let zoneId = "";
  const existingZone = findByLabel(out, MODEL.POLYGON, zoneLabel);
  if (existingZone) {
    zoneId = ids.ensureUnique(existingZone.fields.id ?? existingZone.pk, "pl");
    existingZone.fields.id = zoneId;
    existingZone.pk = zoneId;
  } else {
    zoneId = ids.make("pl");
    pushItem(out, MODEL.POLYGON, zoneId, {
      id: zoneId,
      tags: "[]",
      coord: zonePolygon,
      label: zoneLabel,
      notes: zoneLabel,
      coords: asCoordString(zonePolygon),
      category: CATEGORY.ZONE,
      attribute: { metadata: [], icon_code: "Zone", icon_size: 1 },
      is_active: true,
      tags_list: [],
    });
  }

  // Points + links
  const labelToPointId: Record<string, string> = {};
  meters.forEach((m) => {
    const category =
      m.kind === "flow_meter" ? CATEGORY.FLOW_METER : CATEGORY.PRESSURE_SENSOR;
    const existingPoint = findByLabel(out, MODEL.POINT, m.label);
    if (existingPoint) {
      const pid = ids.ensureUnique(
        existingPoint.fields.id ?? existingPoint.pk,
        "p"
      );
      existingPoint.fields.id = pid;
      existingPoint.pk = pid;
      labelToPointId[m.label] = pid;
    } else {
      const pid = ids.make("p");
      labelToPointId[m.label] = pid;
      pushItem(out, MODEL.POINT, pid, {
        id: pid,
        tags: "[]",
        coord: m.coord,
        label: m.label,
        notes: m.label,
        coords: `${m.coord[0]}, ${m.coord[1]}`,
        category,
        attribute: {
          metadata: [],
          icon_code:
            category === CATEGORY.FLOW_METER ? "Flow_Meter" : "Pressure_Sensor",
          icon_size: 1,
        },
        is_active: true,
        tags_list: [],
      });
    }

    // link point -> zone (inlet)
    const existsLink = out.find(
      (x) =>
        x.model === MODEL.LINK &&
        x.fields?.target_id1 === labelToPointId[m.label] &&
        x.fields?.target_id2 === zoneId &&
        x.fields?.relation_type === "flow_meter_in_zone"
    );
    if (!existsLink) {
      pushItem(out, MODEL.LINK, ids.nextNumPk(), {
        args: { role: ["inlet"], order: null },
        notes: "",
        target_id1: labelToPointId[m.label],
        target_id2: zoneId,
        relation_type: "flow_meter_in_zone",
      });
    }
  });

  // Helper IDs
  const idFM1 = labelToPointId["FM-1"];
  const idFM2 =
    labelToPointId["FM-2-preexisting"] ?? labelToPointId["FM-2"] ?? undefined;

  // Pick AZP pressure sensor: prefer AZP:true, else first PS, else PS-1 seed
  const psList = meters.filter((m) => m.kind === "pressure_sensor");
  const chosenPsLabel =
    psList.find((m) => m.AZP)?.label ?? psList[0]?.label ?? "PS-1";
  const idPsChosen = labelToPointId[chosenPsLabel];

  if (!fullZoneSuite) {
    return JSON.stringify(out, null, indent);
  }

  // ---------- METRICS + TRIGGERS (suite) ----------

  // FM-1 readings (raw -> cleaned) -> volume (delta)
  const mFlowReadRaw = addMetric(
    out,
    ids,
    `Readings - FM-1`,
    CATEGORY.FLOW_READING,
    "m³",
    idFM1,
    INTERVAL.QH,
    ["raw_data"],
    SOURCE.SENSOR,
    60,
    null
  );
  const mFlowReadClean = addMetric(
    out,
    ids,
    `Cleaned Readings - FM-1`,
    CATEGORY.FLOW_READING,
    "m³",
    idFM1,
    INTERVAL.QH,
    ["cleaned"]
  );

  addTrigger(
    out,
    ids,
    `Cleaned Readings - FM-1`,
    [mFlowReadRaw],
    mFlowReadClean,
    [
      {
        calc_args: {
          time_range_type: "operation",
          inputs: {},
          metric_id: cryptoId("clean_flow_fm1"),
        },
        calc_name: "CLEAN_DATA",
      },
    ]
  );

  const mFlowVolFM1 = addMetric(
    out,
    ids,
    `Flow Volume - FM-1`,
    CATEGORY.FLOW_VOLUME,
    "m³",
    idFM1,
    INTERVAL.QH,
    ["raw_data"]
  );
  addTrigger(out, ids, `Flow Volume - FM-1`, [mFlowReadClean], mFlowVolFM1, [
    {
      calc_args: { inputs: {}, metric_id: cryptoId("delta_fm1") },
      calc_name: "CALCULATE_DELTA",
    },
  ]);

  // FM-2 existing as sensor volume (raw)
  let mFlowVolFM2: string | undefined;
  if (idFM2) {
    mFlowVolFM2 = addMetric(
      out,
      ids,
      `Flow Volume - FM-2-preexisting`,
      CATEGORY.FLOW_VOLUME,
      "m³",
      idFM2,
      INTERVAL.QH,
      ["raw_data"],
      SOURCE.SENSOR,
      68,
      null
    );
  }

  // Pressure (raw -> cleaned) for chosen AZP sensor
  const mPressureRaw = addMetric(
    out,
    ids,
    `Pressure - ${chosenPsLabel}`,
    CATEGORY.PRESSURE_READING,
    "m",
    idPsChosen,
    INTERVAL.QH,
    ["raw_data"],
    SOURCE.SENSOR,
    60,
    null
  );
  const mPressureClean = addMetric(
    out,
    ids,
    `Cleaned Pressure - ${chosenPsLabel}`,
    CATEGORY.PRESSURE_READING,
    "m",
    idPsChosen,
    INTERVAL.QH,
    ["cleaned"]
  );
  addTrigger(
    out,
    ids,
    `Cleaned Pressure - ${chosenPsLabel}`,
    [mPressureRaw],
    mPressureClean,
    [
      {
        calc_args: {
          time_range_type: "operation",
          inputs: {},
          metric_id: cryptoId("clean_ps"),
        },
        calc_name: "CLEAN_DATA",
      },
    ]
  );

  // Demand (raw) from FM-1 (+ FM-2 if present)
  const mDemandRaw = addMetric(
    out,
    ids,
    `Demand - ${zoneLabel}`,
    CATEGORY.ZONE_DEMAND,
    "m³",
    zoneId,
    INTERVAL.QH,
    ["raw_data"]
  );
  addTrigger(
    out,
    ids,
    `Demand - ${zoneLabel}`,
    [mFlowVolFM1, mFlowVolFM2].filter(Boolean) as string[],
    mDemandRaw,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("zone_demand"),
          aggregation_groups: ["year", "month", "day", "hour", "quarter_hour"],
          use_histogram_interval: false,
        },
        calc_name: "CALCULATE_ZONE_DEMAND",
      },
    ]
  );

  // Demand (cleaned)
  const mDemandClean = addMetric(
    out,
    ids,
    `Demand (Cleaned) - ${zoneLabel}`,
    CATEGORY.ZONE_DEMAND,
    "m³",
    zoneId,
    INTERVAL.QH,
    ["cleaned"]
  );
  addTrigger(
    out,
    ids,
    `Demand (Cleaned) - ${zoneLabel}`,
    [mDemandRaw],
    mDemandClean,
    [
      {
        calc_args: { inputs: {}, metric_id: cryptoId("clean_demand") },
        calc_name: "CLEAN_DATA",
      },
    ]
  );

  // AZP QH from cleaned pressure
  const mAzpRaw = addMetric(
    out,
    ids,
    `AZP - ${zoneLabel}`,
    CATEGORY.AVG_ZONE_PRESSURE,
    "m",
    zoneId,
    INTERVAL.QH,
    ["raw_data"]
  );
  addTrigger(
    out,
    ids,
    `AZP - ${zoneLabel}`,
    [mPressureClean], // << only the chosen pressure sensor feeds AZP
    mAzpRaw,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("azp_avg_qh"),
          aggregation_groups: [],
          time_range_type: "operation",
        },
        calc_name: "CALCULATE_AVG",
      },
    ]
  );

  // AZP (Cleaned)
  const mAzpClean = addMetric(
    out,
    ids,
    `AZP (Cleaned) - ${zoneLabel}`,
    CATEGORY.AVG_ZONE_PRESSURE,
    "m",
    zoneId,
    INTERVAL.QH,
    ["cleaned"]
  );
  addTrigger(out, ids, `AZP (Cleaned) - ${zoneLabel}`, [mAzpRaw], mAzpClean, [
    {
      calc_args: { inputs: {}, metric_id: cryptoId("clean_azp") },
      calc_name: "CLEAN_DATA",
    },
  ]);

  // Aggregations: Demand daily/hourly
  const mDemandDaily = addMetric(
    out,
    ids,
    `Daily Demand - ${zoneLabel}`,
    CATEGORY.ZONE_DEMAND,
    "m³/day",
    zoneId,
    INTERVAL.DAILY,
    ["sum_aggregated"]
  );
  addTrigger(
    out,
    ids,
    `Daily Demand - ${zoneLabel}`,
    [mDemandClean],
    mDemandDaily,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("demand_daily_sum"),
          aggregation_groups: ["year", "month", "day"],
        },
        calc_name: "CALCULATE_SUM",
      },
    ]
  );

  const mDemandHourly = addMetric(
    out,
    ids,
    `Hourly Demand - ${zoneLabel}`,
    CATEGORY.ZONE_DEMAND,
    "m³/hr",
    zoneId,
    INTERVAL.HOURLY,
    ["sum_aggregated"]
  );
  addTrigger(
    out,
    ids,
    `Hourly Demand - ${zoneLabel}`,
    [mDemandClean],
    mDemandHourly,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("demand_hourly_sum"),
          aggregation_groups: ["year", "month", "day", "hour"],
        },
        calc_name: "CALCULATE_SUM",
      },
    ]
  );

  // Normalized demand (monthly avg)
  const mDemandNorm = addMetric(
    out,
    ids,
    `Demand (Normalized) - ${zoneLabel}`,
    CATEGORY.ZONE_DEMAND,
    "m³",
    zoneId,
    INTERVAL.MONTHLY,
    ["normalized"]
  );
  addTrigger(
    out,
    ids,
    `Demand (Normalized) - ${zoneLabel}`,
    [mDemandClean],
    mDemandNorm,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("demand_norm"),
          aggregation_groups: ["year", "month", "hour", "quarter_hour"],
        },
        calc_name: "CALCULATE_AVG",
      },
    ]
  );

  // Variance in normalized demand
  const mDemandVar = addMetric(
    out,
    ids,
    `Variance in Normalized Demand - ${zoneLabel}`,
    CATEGORY.DEMAND_VAR,
    "m³",
    zoneId,
    INTERVAL.MONTHLY,
    ["normalized", "hidden"]
  );
  addTrigger(
    out,
    ids,
    `Monthly Variance in Normalized Demand - ${zoneLabel}`,
    [mDemandNorm],
    mDemandVar,
    [
      {
        calc_args: { inputs: {}, metric_id: cryptoId("demand_norm_var") },
        calc_name: "CALCULATE_NORMALIZE_VAR",
      },
    ]
  );

  // AZP normalized (monthly avg over cleaned AZP)
  const mAzpNorm = addMetric(
    out,
    ids,
    `AZP (Normalized) - ${zoneLabel}`,
    CATEGORY.AVG_ZONE_PRESSURE,
    "m",
    zoneId,
    INTERVAL.MONTHLY,
    ["normalized"]
  );
  addTrigger(
    out,
    ids,
    `AZP (Normalized) - ${zoneLabel}`,
    [mAzpClean],
    mAzpNorm,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("azp_norm"),
          aggregation_groups: ["year", "month", "hour", "quarter_hour"],
        },
        calc_name: "CALCULATE_AVG",
      },
    ]
  );

  // Variance in normalized AZP
  const mAzpVar = addMetric(
    out,
    ids,
    `Variance in Normalized AZP - ${zoneLabel}`,
    CATEGORY.AVG_ZONE_PRESSURE_VAR,
    "m",
    zoneId,
    INTERVAL.MONTHLY,
    ["normalized", "hidden"]
  );
  addTrigger(
    out,
    ids,
    `Monthly Variance in Normalized AZP - ${zoneLabel}`,
    [mAzpClean],
    mAzpVar,
    [
      {
        calc_args: { inputs: {}, metric_id: cryptoId("azp_norm_var") },
        calc_name: "CALCULATE_NORMALIZE_VAR",
      },
    ]
  );

  // MNF (Daily) from cleaned demand
  const mMnfDaily = addMetric(
    out,
    ids,
    `MNF (Daily) - ${zoneLabel}`,
    CATEGORY.ZONE_DEMAND,
    "m³/day",
    zoneId,
    INTERVAL.DAILY,
    []
  );
  addTrigger(
    out,
    ids,
    `MNF (Daily) - ${zoneLabel}`,
    [mDemandClean],
    mMnfDaily,
    [
      {
        calc_args: { inputs: {}, metric_id: cryptoId("mnf_daily") },
        calc_name: "CALCULATE_DAILY_MNF",
      },
    ]
  );

  // MNF (Monthly) <- (DemandVar, AzpVar, DemandNorm) using **metric IDs**, not indexes
  const mMnfMonthly = addMetric(
    out,
    ids,
    `MNF (Monthly) - ${zoneLabel}`,
    CATEGORY.MNF,
    "m³/day",
    zoneId,
    INTERVAL.MONTHLY,
    []
  );
  addTrigger(
    out,
    ids,
    `MNF (Monthly) - ${zoneLabel}`,
    [mDemandVar, mAzpVar, mDemandNorm],
    mMnfMonthly,
    [
      {
        calc_args: {
          inputs: {
            flow_variance: mDemandVar,
            average_zone_pressure_variance: mAzpVar,
            flow: mDemandNorm,
          },
          metric_id: cryptoId("mnf_monthly"),
        },
        calc_name: "CALCULATE_MNF",
      },
    ]
  );
  // PMNF (Monthly): pressure at the minimum night flow
  const mPmnf = addMetric(
    out,
    ids,
    `PMNF - ${zoneLabel}`,
    CATEGORY.PMNF,
    "m/15 min",
    zoneId,
    INTERVAL.MONTHLY,
    ["normalized"]
  );

  addTrigger(
    out,
    ids,
    `PMNF - Monthly - ${zoneLabel}`,
    [mMnfMonthly, mAzpNorm],
    mPmnf,
    [
      {
        calc_args: {
          inputs: {
            minimum_night_flow: mMnfMonthly,
            average_zone_pressure: mAzpNorm,
          },
          metric_id: cryptoId("pmnf_monthly"),
        },
        calc_name: "CALCULATE_PMNF",
      },
    ]
  );

  // Leak Volume QH -> monthly sum
  const mLeakQh = addMetric(
    out,
    ids,
    `Leak Volume - ${zoneLabel}`,
    CATEGORY.ZONE_LEAK,
    "m³/h",
    zoneId,
    INTERVAL.QH,
    []
  );
  const leakQhCalcId = cryptoId("leak_qh"); // first calc id in this trigger
  const leakMonthlySumCalcId = cryptoId("leak_monthly_sum"); // second calc id in this trigger

  addTrigger(
    out,
    ids,
    `Leak Volume - ${zoneLabel}`,
    [mAzpNorm, mMnfMonthly], // input_metrics list (ids) — AZP normalized + MNF monthly
    mLeakQh,
    [
      // 1) Compute QH leak using named metric-id inputs (no indexes)
      {
        calc_args: {
          inputs: {
            average_zone_pressure: mAzpNorm, // expected style uses metric id string
            minimum_night_flow: mMnfMonthly,
            // if you also have a dedicated "min_night_azp" metric, pass it here instead of mAzpNorm:
            min_night_azp: mAzpNorm,
          },
          metric_id: leakQhCalcId,
        },
        calc_name: "FAVED_LEAKAGE_VOLUME",
      },
      // 2) Monthly SUM over that previous calc (by its calc metric_id)
      {
        calc_args: {
          inputs: { metrics_calcs: [leakQhCalcId] },
          metric_id: leakMonthlySumCalcId,
          aggregation_groups: ["year", "month"],
        },
        calc_name: "CALCULATE_SUM",
      },
    ]
  );

  // Daily / Monthly leak metrics (summed)
  const mLeakDaily = addMetric(
    out,
    ids,
    `Daily Leak - ${zoneLabel}`,
    CATEGORY.ZONE_LEAK,
    "m³/day",
    zoneId,
    INTERVAL.DAILY,
    ["sum_aggregated"]
  );
  addTrigger(out, ids, `Daily Leak - ${zoneLabel}`, [mLeakQh], mLeakDaily, [
    {
      calc_args: {
        inputs: {},
        metric_id: cryptoId("leak_daily_sum"),
        aggregation_groups: ["year", "month", "day"],
      },
      calc_name: "CALCULATE_SUM",
    },
  ]);

  const mLeakMonthly = addMetric(
    out,
    ids,
    `Monthly Leak - ${zoneLabel}`,
    CATEGORY.ZONE_LEAK,
    "m³",
    zoneId,
    INTERVAL.MONTHLY,
    ["sum_aggregated"]
  );
  addTrigger(out, ids, `Monthly Leak - ${zoneLabel}`, [mLeakQh], mLeakMonthly, [
    {
      calc_args: {
        inputs: {},
        metric_id: cryptoId("leak_monthly_sum_metric"),
        aggregation_groups: ["year", "month"],
      },
      calc_name: "CALCULATE_SUM",
    },
  ]);

  // PeakFactor (daily)
  const mPeakDaily = addMetric(
    out,
    ids,
    `PeakFactor - ${zoneLabel}`,
    CATEGORY.ZONE_DEMAND,
    "",
    zoneId,
    INTERVAL.DAILY,
    []
  );
  addTrigger(
    out,
    ids,
    `PeakFactor - Daily - ${zoneLabel}`,
    [mDemandClean],
    mPeakDaily,
    [
      {
        calc_args: { inputs: {}, metric_id: cryptoId("peakfactor_daily") },
        calc_name: "CALCULATE_PEAKFACTOR",
      },
    ]
  );

  // UARL / UBL monthly (normalized -> sum)
  const mUarlNorm = addMetric(
    out,
    ids,
    `UARL (Normalized) - ${zoneLabel}`,
    CATEGORY.UARL,
    "m³/day",
    zoneId,
    INTERVAL.MONTHLY,
    ["sum_aggregated"]
  );
  addTrigger(
    out,
    ids,
    `UARL (Normalized) - Monthly - ${zoneLabel}`,
    [mAzpNorm],
    mUarlNorm,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("uarl_norm"),
          azp_unit: "m",
          uarl_unit: "m3/h",
          aggregation_groups: ["year", "month", "hour", "quarter_hour"],
        },
        calc_name: "CALCULATE_UARL",
      },
    ]
  );

  const mUarl = addMetric(
    out,
    ids,
    `UARL - ${zoneLabel}`,
    CATEGORY.UARL,
    "m³/day",
    zoneId,
    INTERVAL.MONTHLY,
    ["sum_aggregated"]
  );
  addTrigger(out, ids, `UARL - Monthly - ${zoneLabel}`, [mUarlNorm], mUarl, [
    {
      calc_args: {
        inputs: {},
        metric_id: cryptoId("uarl_monthly_sum"),
        aggregation_groups: ["year", "month"],
      },
      calc_name: "CALCULATE_SUM",
    },
  ]);

  const mUblNorm = addMetric(
    out,
    ids,
    `UBL (Normalized) - ${zoneLabel}`,
    CATEGORY.UBL,
    "m³/day",
    zoneId,
    INTERVAL.MONTHLY,
    ["sum_aggregated"]
  );
  addTrigger(
    out,
    ids,
    `UBL (Normalized) - Monthly - ${zoneLabel}`,
    [mAzpNorm],
    mUblNorm,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("ubl_norm"),
          azp_unit: "m",
          ubl_unit: "m3/h",
          aggregation_groups: ["year", "month", "hour", "quarter_hour"],
        },
        calc_name: "CALCULATE_UBL",
      },
    ]
  );

  const mUbl = addMetric(
    out,
    ids,
    `UBL - ${zoneLabel}`,
    CATEGORY.UBL,
    "m³/day",
    zoneId,
    INTERVAL.MONTHLY,
    ["sum_aggregated"]
  );
  addTrigger(out, ids, `UBL - Monthly - ${zoneLabel}`, [mUblNorm], mUbl, [
    {
      calc_args: {
        inputs: {},
        metric_id: cryptoId("ubl_monthly_sum"),
        aggregation_groups: ["year", "month"],
      },
      calc_name: "CALCULATE_SUM",
    },
  ]);

  // ILI (two-step: calc -> monthly avg over previous calc)
  const mIli = addMetric(
    out,
    ids,
    `ILI - ${zoneLabel}`,
    CATEGORY.ILI,
    "",
    zoneId,
    INTERVAL.MONTHLY,
    ["sum_aggregated"]
  );
  const iliCalcId = cryptoId("ili_calc");
  const iliAvgId = cryptoId("ili_avg");

  addTrigger(
    out,
    ids,
    `ili_monthly - ${zoneLabel}`,
    [mUarl, mLeakMonthly],
    mIli,
    [
      {
        calc_args: {
          inputs: { uarl: mUarl, total_leakage: mLeakMonthly },
          metric_id: iliCalcId,
          aggregation_groups: ["year", "month", "hour", "quarter_hour"],
        },
        calc_name: "CALCULATE_ILI",
      },
      {
        calc_args: {
          inputs: { metrics_calcs: [iliCalcId] },
          metric_id: iliAvgId,
          aggregation_groups: ["year", "month"],
        },
        calc_name: "CALCULATE_AVG",
      },
    ]
  );

  // ICF (two-step: calc -> monthly avg over previous calc)
  const mIcf = addMetric(
    out,
    ids,
    `ICF - ${zoneLabel}`,
    CATEGORY.ICF,
    "",
    zoneId,
    INTERVAL.MONTHLY,
    ["sum_aggregated"]
  );
  const icfCalcId = cryptoId("icf_calc");
  const icfAvgId = cryptoId("icf_avg");

  addTrigger(out, ids, `icf_monthly - ${zoneLabel}`, [mUarl, mUbl], mIcf, [
    {
      calc_args: {
        inputs: { uarl: mUarl, ubl: mUbl },
        metric_id: icfCalcId,
        aggregation_groups: ["year", "month", "hour", "quarter_hour"],
      },
      calc_name: "CALCULATE_ICF",
    },
    {
      calc_args: {
        inputs: { metrics_calcs: [icfCalcId] },
        metric_id: icfAvgId,
        aggregation_groups: ["year", "month"],
      },
      calc_name: "CALCULATE_AVG",
    },
  ]);

  // NDF (Monthly) — use **metric ids** and the leak monthly SUM **calc id** for leakage_sum
  const mNdf = addMetric(
    out,
    ids,
    `NDF - ${zoneLabel}`,
    CATEGORY.NDF,
    "",
    zoneId,
    INTERVAL.MONTHLY,
    []
  );
  addTrigger(
    out,
    ids,
    `ndf_monthly - ${zoneLabel}`,
    [mMnfMonthly, mAzpNorm, mPmnf, mLeakMonthly],
    mNdf,
    [
      {
        calc_args: {
          time_range_type: "operation",
          inputs: {
            min_night_flow: mMnfMonthly,
            min_night_azp: mPmnf,
            leakage_sum: mLeakMonthly,
            normalized_azp: mAzpNorm,
          },
          metric_id: cryptoId("ndf_calc"),
        },
        calc_name: "CALCULATE_NDF",
      },
    ]
  );

  // Recoverable leak (normalized): leak - uarl using metrics_calcs (metric ids)
  const mRecovNorm = addMetric(
    out,
    ids,
    `Monthly Normalized Recoverable Leak - ${zoneLabel}`,
    CATEGORY.MAX_REC_LEAK,
    "m³",
    zoneId,
    INTERVAL.MONTHLY,
    ["normalized"]
  );
  addTrigger(
    out,
    ids,
    `Monthly Normalized Recoverable Leak - ${zoneLabel}`,
    [mUarl, mLeakMonthly],
    mRecovNorm,
    [
      {
        calc_args: {
          inputs: { metrics_calcs: [mLeakMonthly, mUarl] },
          metric_id: cryptoId("recov_norm"),
          time_range_type: "operation",
        },
        calc_name: "CALCULATE_SUBTRACTION",
      },
    ]
  );

  // Avg daily recoverable leak (monthly)
  const mAvgDailyRecov = addMetric(
    out,
    ids,
    `Avg Daily Recoverable Leak - ${zoneLabel}`,
    CATEGORY.MAX_REC_LEAK,
    "m³/day",
    zoneId,
    INTERVAL.MONTHLY,
    []
  );
  addTrigger(
    out,
    ids,
    `Avg Daily Recoverable Leak - Monthly - ${zoneLabel}`,
    [mRecovNorm],
    mAvgDailyRecov,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("avg_daily_recov"),
          aggregation_groups: ["year", "month"],
        },
        calc_name: "CALCULATE_SUM",
      },
    ]
  );

  // Financials
  const mDailySavings = addMetric(
    out,
    ids,
    `Potential Savings - Avg Daily - ${zoneLabel}`,
    CATEGORY.MAX_REC_LEAK,
    "$/day",
    zoneId,
    INTERVAL.MONTHLY,
    ["potential_financial_savings"]
  );
  addTrigger(
    out,
    ids,
    `Potential Savings - Avg Daily - Monthly - ${zoneLabel}`,
    [mAvgDailyRecov],
    mDailySavings,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("daily_savings"),
          category: "water_price",
          source_id: zoneId,
          factor_type: "multiplication",
          offset: 0,
          time_range_type: "operation",
        },
        calc_name: "CONSTANT_DATUM_FACTOR_OFFSET",
      },
    ]
  );

  const mMonthlySavings = addMetric(
    out,
    ids,
    `Potential Financial Savings - Avg Monthly - ${zoneLabel}`,
    CATEGORY.MAX_REC_LEAK,
    "$/month",
    zoneId,
    INTERVAL.MONTHLY,
    ["potential_financial_savings"]
  );
  addTrigger(
    out,
    ids,
    `Potential Financial Savings - Avg Monthly - ${zoneLabel}`,
    [mDailySavings],
    mMonthlySavings,
    [
      {
        calc_args: {
          factor: 30,
          inputs: {},
          offset: 0,
          metric_id: cryptoId("monthly_savings"),
        },
        calc_name: "CALCULATE_TRANSFORM",
      },
    ]
  );

  // Real losses
  const mRealLossQh = addMetric(
    out,
    ids,
    `Real losses (RT) - ${zoneLabel}`,
    CATEGORY.REAL_LOSSES,
    "m³",
    zoneId,
    INTERVAL.QH,
    []
  );
  addTrigger(out, ids, `Real losses - ${zoneLabel}`, [mLeakQh], mRealLossQh, [
    {
      calc_args: {
        factor: 1,
        inputs: {},
        offset: 0,
        metric_id: cryptoId("real_losses_rt"),
      },
      calc_name: "CALCULATE_TRANSFORM",
    },
  ]);

  const mRealLossMonthly = addMetric(
    out,
    ids,
    `Monthly Real Losses - ${zoneLabel}`,
    CATEGORY.REAL_LOSSES,
    "m³",
    zoneId,
    INTERVAL.MONTHLY,
    ["sum_aggregated"]
  );
  addTrigger(
    out,
    ids,
    `Monthly Real Losses - ${zoneLabel}`,
    [mRealLossQh],
    mRealLossMonthly,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("real_losses_monthly_sum"),
          aggregation_groups: ["year", "month"],
        },
        calc_name: "CALCULATE_SUM",
      },
    ]
  );

  const mRealLossCost = addMetric(
    out,
    ids,
    `Monthly Cost of Real Losses - ${zoneLabel}`,
    CATEGORY.REAL_LOSSES,
    "$/month",
    zoneId,
    INTERVAL.MONTHLY,
    ["financial_losses"]
  );
  addTrigger(
    out,
    ids,
    `Monthly Cost of Real Losses - ${zoneLabel}`,
    [mRealLossMonthly],
    mRealLossCost,
    [
      {
        calc_args: {
          inputs: {},
          metric_id: cryptoId("real_losses_cost"),
          time_range_type: "operation",
          category: "water_price",
          source_id: zoneId,
          factor_type: "multiplication",
          offset: 0,
        },
        calc_name: "CONSTANT_DATUM_FACTOR_OFFSET",
      },
    ]
  );

  return JSON.stringify(out, null, indent);
}

/** portable random-ish string for calculator metric_id fields */
function cryptoId(seed: string) {
  const base = `${seed}-${Date.now()}-${Math.random()}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  const hex = h.toString(16);
  const leftPad8 = ("00000000" + hex).slice(-8);
  const rand = () => Math.random().toString(36).slice(2, 6);
  return `${leftPad8}-${rand()}-${rand()}-${rand()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
