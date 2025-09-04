export type BuildOptions = {
  indent?: number;
  fullZoneSuite?: boolean;
  keepExisting?: boolean;
};

export type FixtureItem = {
  model: string;
  pk: string | number;
  fields: any;
};

export const MODEL = {
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

function isFlatDomainList(x: any): x is any[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    typeof x[0] === "object" &&
    !("model" in x[0]) &&
    ("category" in x[0] || "coords" in x[0] || "label" in x[0])
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
export class IdRegistry {
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

  ensureUnique(id: string, prefix: "pl" | "p" | "m" | "t"): string {
    if (!this.usedText[id]) {
      this.usedText[id] = true;
      return id;
    }
    return this.make(prefix);
  }
}

export function pushItem(
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

/** Add a trigger with calculators; normalize calc_args for consistency */
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

  const normalizedCalculators = (
    Array.isArray(calculators) ? calculators : []
  ).map((c) => {
    const calc = c ? { ...c } : {};
    const args =
      calc && typeof calc.calc_args === "object" && calc.calc_args !== null
        ? { ...calc.calc_args }
        : {};
    if (args.time_range_type == null) args.time_range_type = "operation";
    if (args.inputs == null || typeof args.inputs !== "object")
      args.inputs = {};
    if (!args.metric_id) args.metric_id = cryptoId("calc");
    if (
      (c?.calc_name === "CALCULATE_AVG" || c?.calc_name === "CALCULATE_SUM") &&
      args.aggregation_groups == null
    ) {
      args.aggregation_groups = [];
    }
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
    input_metrics: (inputMetrics || []).filter(Boolean),
    output_metric: outputMetric,
  });
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

type MeterSeed = {
  kind: "flow_meter" | "pressure_sensor";
  label: string;
  coord: [number, number];
  AZP?: boolean;

  // Optional hints for an existing sensor metric (e.g. FM-2-preexisting)
  metric_category?: string | null;
  metric_unit?: string | null;
  metric_interval?: string | null;
  metric_storage_table?: number | null;
};

type ZoneSeed = {
  label: string;
  polygon: number[][][];
  meters: MeterSeed[];
};

/** Build one full zone (polygon, points, links, metrics/triggers) strictly from provided data */
function buildZoneSuite(
  out: FixtureItem[],
  ids: IdRegistry,
  zone: ZoneSeed,
  fullZoneSuite: boolean
) {
  const zoneLabel = zone.label;
  const zonePolygon = zone.polygon;

  // Zone polygon (create or update by label)
  let zoneId = "";
  const existingZone = findByLabel(out, MODEL.POLYGON, zoneLabel);
  if (existingZone) {
    zoneId = ids.ensureUnique(existingZone.fields.id ?? existingZone.pk, "pl");
    existingZone.fields.id = zoneId;
    existingZone.pk = zoneId;
    existingZone.fields.coord = zonePolygon;
    existingZone.fields.coords = asCoordString(zonePolygon);
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
  const meters: MeterSeed[] = Array.isArray(zone.meters)
    ? [...zone.meters]
    : [];
  const labelToPointId: Record<string, string> = {};

  for (const m of meters) {
    if (!m || !m.kind || !m.label || !Array.isArray(m.coord)) continue;
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
      existingPoint.fields.coord = m.coord;
      existingPoint.fields.coords = `${m.coord[0]}, ${m.coord[1]}`;
      existingPoint.fields.category = category;
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

    // 🔧 Link ONLY flow meters to the zone
    if (m.kind === "flow_meter") {
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
    }
  }

  if (!fullZoneSuite) return;

  // ---------- METRICS + TRIGGERS (suite) ----------
  // Build all flow chains -> collect flow volume metrics for demand aggregation.
  const flowMeters = meters.filter((m) => m.kind === "flow_meter");
  const flowVolMetricIds: string[] = [];

  for (const fm of flowMeters) {
    const pid = labelToPointId[fm.label];
    if (!pid) continue;

    if (fm.metric_category && fm.metric_interval) {
      // Use provided sensor metric hints as-is
      const mFlowVol = addMetric(
        out,
        ids,
        `Flow Volume - ${fm.label}`,
        fm.metric_category || CATEGORY.FLOW_VOLUME,
        fm.metric_unit || "m³",
        pid,
        fm.metric_interval || INTERVAL.QH,
        ["raw_data"],
        SOURCE.SENSOR,
        fm.metric_storage_table ?? 68,
        null
      );
      flowVolMetricIds.push(mFlowVol);
    } else {
      // readings (sensor) -> cleaned -> delta (volume)
      const mFlowReadRaw = addMetric(
        out,
        ids,
        `Readings - ${fm.label}`,
        CATEGORY.FLOW_READING,
        "m³",
        pid,
        INTERVAL.QH,
        ["raw_data"],
        SOURCE.SENSOR,
        60,
        null
      );
      const mFlowReadClean = addMetric(
        out,
        ids,
        `Cleaned Readings - ${fm.label}`,
        CATEGORY.FLOW_READING,
        "m³",
        pid,
        INTERVAL.QH,
        ["cleaned"]
      );
      addTrigger(
        out,
        ids,
        `Cleaned Readings - ${fm.label}`,
        [mFlowReadRaw],
        mFlowReadClean,
        [{ calc_name: "CLEAN_DATA", calc_args: { inputs: {} } }]
      );
      const mFlowVol = addMetric(
        out,
        ids,
        `Flow Volume - ${fm.label}`,
        CATEGORY.FLOW_VOLUME,
        "m³",
        pid,
        INTERVAL.QH,
        ["raw_data"]
      );
      addTrigger(
        out,
        ids,
        `Flow Volume - ${fm.label}`,
        [mFlowReadClean],
        mFlowVol,
        [{ calc_name: "CALCULATE_DELTA", calc_args: { inputs: {} } }]
      );
      flowVolMetricIds.push(mFlowVol);
    }
  }

  // Pressure chain (choose AZP sensor: prefer AZP flagged, else first)
  const pressureSensors = meters.filter((m) => m.kind === "pressure_sensor");
  const chosenPs =
    pressureSensors.find((m) => m.AZP) || pressureSensors[0] || undefined;

  let mPressureClean: string | undefined;
  if (chosenPs) {
    const psPid = labelToPointId[chosenPs.label];
    if (psPid) {
      const mPressureRaw = addMetric(
        out,
        ids,
        `Pressure - ${chosenPs.label}`,
        CATEGORY.PRESSURE_READING,
        "m",
        psPid,
        INTERVAL.QH,
        ["raw_data"],
        SOURCE.SENSOR,
        60,
        null
      );
      mPressureClean = addMetric(
        out,
        ids,
        `Cleaned Pressure - ${chosenPs.label}`,
        CATEGORY.PRESSURE_READING,
        "m",
        psPid,
        INTERVAL.QH,
        ["cleaned"]
      );
      addTrigger(
        out,
        ids,
        `Cleaned Pressure - ${chosenPs.label}`,
        [mPressureRaw],
        mPressureClean,
        [{ calc_name: "CLEAN_DATA", calc_args: { inputs: {} } }]
      );
    }
  }

  // Demand from available flow volumes
  let mDemandClean: string | undefined;
  if (flowVolMetricIds.length > 0) {
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
      flowVolMetricIds,
      mDemandRaw,
      [
        {
          calc_name: "CALCULATE_ZONE_DEMAND",
          calc_args: {
            inputs: {},
            aggregation_groups: [
              "year",
              "month",
              "day",
              "hour",
              "quarter_hour",
            ],
            use_histogram_interval: false,
          },
        },
      ]
    );

    mDemandClean = addMetric(
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
      [{ calc_name: "CLEAN_DATA", calc_args: { inputs: {} } }]
    );
  }

  // AZP from pressure clean (QH avg -> clean -> monthly norm + var)
  let mAzpClean: string | undefined;
  let mAzpNorm: string | undefined;
  let mAzpVar: string | undefined;
  if (mPressureClean) {
    const mAzpQhRaw = addMetric(
      out,
      ids,
      `AZP - ${zoneLabel}`,
      CATEGORY.AVG_ZONE_PRESSURE,
      "m",
      zoneId,
      INTERVAL.QH,
      ["raw_data"]
    );
    addTrigger(out, ids, `AZP - ${zoneLabel}`, [mPressureClean], mAzpQhRaw, [
      {
        calc_name: "CALCULATE_AVG",
        calc_args: { inputs: {}, aggregation_groups: [] },
      },
    ]);

    mAzpClean = addMetric(
      out,
      ids,
      `AZP (Cleaned) - ${zoneLabel}`,
      CATEGORY.AVG_ZONE_PRESSURE,
      "m",
      zoneId,
      INTERVAL.QH,
      ["cleaned"]
    );
    addTrigger(
      out,
      ids,
      `AZP (Cleaned) - ${zoneLabel}`,
      [mAzpQhRaw],
      mAzpClean,
      [{ calc_name: "CLEAN_DATA", calc_args: { inputs: {} } }]
    );

    mAzpNorm = addMetric(
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
          calc_name: "CALCULATE_AVG",
          calc_args: {
            inputs: {},
            aggregation_groups: ["year", "month", "hour", "quarter_hour"],
          },
        },
      ]
    );

    mAzpVar = addMetric(
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
      [{ calc_name: "CALCULATE_NORMALIZE_VAR", calc_args: { inputs: {} } }]
    );
  }

  // Demand aggregations & normalization
  let mDemandNorm: string | undefined;
  let mDemandVar: string | undefined;
  if (mDemandClean) {
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
          calc_name: "CALCULATE_SUM",
          calc_args: {
            inputs: {},
            aggregation_groups: ["year", "month", "day"],
          },
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
          calc_name: "CALCULATE_SUM",
          calc_args: {
            inputs: {},
            aggregation_groups: ["year", "month", "day", "hour"],
          },
        },
      ]
    );

    mDemandNorm = addMetric(
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
          calc_name: "CALCULATE_AVG",
          calc_args: {
            inputs: {},
            aggregation_groups: ["year", "month", "hour", "quarter_hour"],
          },
        },
      ]
    );

    mDemandVar = addMetric(
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
      [{ calc_name: "CALCULATE_NORMALIZE_VAR", calc_args: { inputs: {} } }]
    );
  }

  // Full suite that needs both demand & pressure chains
  if (mDemandVar && mDemandNorm && mAzpVar && mAzpNorm) {
    // MNF monthly
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
          calc_name: "CALCULATE_MNF",
          calc_args: {
            inputs: {
              flow_variance: mDemandVar,
              average_zone_pressure_variance: mAzpVar,
              flow: mDemandNorm,
            },
          },
        },
      ]
    );

    // PMNF (Monthly)
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
          calc_name: "CALCULATE_PMNF",
          calc_args: {
            inputs: {
              minimum_night_flow: mMnfMonthly,
              average_zone_pressure: mAzpNorm,
            },
          },
        },
      ]
    );

    // Leak Volume (QH) + rollups
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
    const leakQhCalcId = cryptoId(`leak_qh_${zoneLabel}`);
    addTrigger(
      out,
      ids,
      `Leak Volume - ${zoneLabel}`,
      [mAzpNorm, mMnfMonthly],
      mLeakQh,
      [
        {
          calc_name: "FAVED_LEAKAGE_VOLUME",
          calc_args: {
            inputs: {
              average_zone_pressure: mAzpNorm,
              minimum_night_flow: mMnfMonthly,
              min_night_azp: mAzpNorm,
            },
            metric_id: leakQhCalcId,
          },
        },
      ]
    );

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
        calc_name: "CALCULATE_SUM",
        calc_args: { inputs: {}, aggregation_groups: ["year", "month", "day"] },
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
    addTrigger(
      out,
      ids,
      `Monthly Leak - ${zoneLabel}`,
      [mLeakQh],
      mLeakMonthly,
      [
        {
          calc_name: "CALCULATE_SUM",
          calc_args: { inputs: {}, aggregation_groups: ["year", "month"] },
        },
      ]
    );

    // UARL / UBL
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
          calc_name: "CALCULATE_UARL",
          calc_args: {
            inputs: {},
            azp_unit: "m",
            uarl_unit: "m3/h",
            aggregation_groups: ["year", "month", "hour", "quarter_hour"],
          },
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
        calc_name: "CALCULATE_SUM",
        calc_args: { inputs: {}, aggregation_groups: ["year", "month"] },
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
          calc_name: "CALCULATE_UBL",
          calc_args: {
            inputs: {},
            azp_unit: "m",
            ubl_unit: "m3/h",
            aggregation_groups: ["year", "month", "hour", "quarter_hour"],
          },
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
        calc_name: "CALCULATE_SUM",
        calc_args: { inputs: {}, aggregation_groups: ["year", "month"] },
      },
    ]);

    // ILI (calc -> monthly avg)
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
    const iliCalcId = cryptoId(`ili_calc_${zoneLabel}`);
    addTrigger(
      out,
      ids,
      `ili_monthly - ${zoneLabel}`,
      [mUarl, mLeakMonthly],
      mIli,
      [
        {
          calc_name: "CALCULATE_ILI",
          calc_args: {
            inputs: { uarl: mUarl, total_leakage: mLeakMonthly },
            metric_id: iliCalcId,
            aggregation_groups: ["year", "month", "hour", "quarter_hour"],
          },
        },
        {
          calc_name: "CALCULATE_AVG",
          calc_args: {
            inputs: { metrics_calcs: [iliCalcId] },
            aggregation_groups: ["year", "month"],
          },
        },
      ]
    );

    // ICF (calc -> monthly avg)
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
    const icfCalcId = cryptoId(`icf_calc_${zoneLabel}`);
    addTrigger(out, ids, `icf_monthly - ${zoneLabel}`, [mUarl, mUbl], mIcf, [
      {
        calc_name: "CALCULATE_ICF",
        calc_args: {
          inputs: { uarl: mUarl, ubl: mUbl },
          metric_id: icfCalcId,
          aggregation_groups: ["year", "month", "hour", "quarter_hour"],
        },
      },
      {
        calc_name: "CALCULATE_AVG",
        calc_args: {
          inputs: { metrics_calcs: [icfCalcId] },
          aggregation_groups: ["year", "month"],
        },
      },
    ]);

    // NDF monthly
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
          calc_name: "CALCULATE_NDF",
          calc_args: {
            inputs: {
              min_night_flow: mMnfMonthly,
              min_night_azp: mPmnf,
              leakage_sum: mLeakMonthly,
              normalized_azp: mAzpNorm,
            },
            time_range_type: "operation",
          },
        },
      ]
    );

    // Recoverable leak & financials
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
          calc_name: "CALCULATE_SUBTRACTION",
          calc_args: {
            inputs: { metrics_calcs: [mLeakMonthly, mUarl] },
            time_range_type: "operation",
          },
        },
      ]
    );

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
          calc_name: "CALCULATE_SUM",
          calc_args: { inputs: {}, aggregation_groups: ["year", "month"] },
        },
      ]
    );

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
          calc_name: "CONSTANT_DATUM_FACTOR_OFFSET",
          calc_args: {
            inputs: {},
            category: "water_price",
            source_id: zoneId,
            factor_type: "multiplication",
            offset: 0,
            time_range_type: "operation",
          },
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
          calc_name: "CALCULATE_TRANSFORM",
          calc_args: { factor: 30, inputs: {}, offset: 0 },
        },
      ]
    );

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
        calc_name: "CALCULATE_TRANSFORM",
        calc_args: { factor: 1, inputs: {}, offset: 0 },
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
          calc_name: "CALCULATE_SUM",
          calc_args: { inputs: {}, aggregation_groups: ["year", "month"] },
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
          calc_name: "CONSTANT_DATUM_FACTOR_OFFSET",
          calc_args: {
            inputs: {},
            category: "water_price",
            source_id: zoneId,
            factor_type: "multiplication",
            offset: 0,
            time_range_type: "operation",
          },
        },
      ]
    );
  }
}

/** -------- Domain-list parser (flat input shape) -------- */
type DomainItem = {
  category: string;
  label: string;
  coords: any;
  inletFor?: string | null;
  AZP?: boolean;
  metric_category?: string | null;
  metric_unit?: string | null;
  metric_interval?: string | null;
  metric_storage_table?: number | null;
};

function parseFlatDomainList(items: DomainItem[]) {
  const zones: Record<string, ZoneSeed> = {};
  const metersByZone: Record<string, MeterSeed[]> = {};
  const looseMeters: MeterSeed[] = [];

  // collect zones
  for (const it of items) {
    if (!it || String(it.category || "").trim() !== CATEGORY.ZONE) continue;
    const label = String(it.label || "").trim();
    if (!label || !Array.isArray(it.coords)) continue;
    zones[label] = { label, polygon: it.coords as number[][][], meters: [] };
    metersByZone[label] = [];
  }

  const zoneNames = Object.keys(zones);
  const singleZoneName = zoneNames.length === 1 ? zoneNames[0] : null;

  // collect meters and attach by inletFor; fallback to the only zone even if inletFor mismatches
  for (const it of items) {
    const cat = String(it.category || "").trim();
    if (cat !== CATEGORY.FLOW_METER && cat !== CATEGORY.PRESSURE_SENSOR)
      continue;

    const label = String(it.label || "").trim();
    if (!label || !Array.isArray(it.coords)) continue;

    const meter: MeterSeed = {
      kind: cat as MeterSeed["kind"],
      label,
      coord: it.coords as [number, number],
      AZP: !!it.AZP,
      metric_category: it.metric_category ?? null,
      metric_unit: it.metric_unit ?? null,
      metric_interval: it.metric_interval ?? null,
      metric_storage_table: it.metric_storage_table ?? null,
    };

    let zName = (it.inletFor ? String(it.inletFor).trim() : "") || "";

    // 🔧 Key fix: with exactly one zone, always attach there if the specified inletFor is missing/mismatched
    if (singleZoneName) {
      if (!zName) zName = singleZoneName;
      else if (!zones[zName]) zName = singleZoneName;
    }

    if (zName && zones[zName]) {
      metersByZone[zName].push(meter);
    } else {
      looseMeters.push(meter);
    }
  }

  // stitch meters onto zones
  for (const zName of Object.keys(zones)) {
    zones[zName].meters = metersByZone[zName] || [];
  }

  return {
    zonesToBuild: Object.values(zones),
    unassignedMeters: looseMeters,
  };
}

/** Main builder: supports flat list, {zones:[...]}, legacy {zone,meters}, and fixture passthrough */
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

  // Case 1: flat domain list
  if (isFlatDomainList(input)) {
    const { zonesToBuild, unassignedMeters } = parseFlatDomainList(
      input as DomainItem[]
    );

    for (const zone of zonesToBuild) {
      buildZoneSuite(out, ids, zone, fullZoneSuite);
    }

    // Create unassigned meters as free points (no links). If hints exist for flow meters, create sensor metric.
    for (const m of unassignedMeters) {
      const category =
        m.kind === "flow_meter"
          ? CATEGORY.FLOW_METER
          : CATEGORY.PRESSURE_SENSOR;
      const existingPoint = findByLabel(out, MODEL.POINT, m.label);
      let pid: string;
      if (existingPoint) {
        pid = ids.ensureUnique(
          existingPoint.fields.id ?? existingPoint.pk,
          "p"
        );
        existingPoint.fields.id = pid;
        existingPoint.pk = pid;
        existingPoint.fields.coord = m.coord;
        existingPoint.fields.coords = `${m.coord[0]}, ${m.coord[1]}`;
        existingPoint.fields.category = category;
      } else {
        pid = ids.make("p");
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
              category === CATEGORY.FLOW_METER
                ? "Flow_Meter"
                : "Pressure_Sensor",
            icon_size: 1,
          },
          is_active: true,
          tags_list: [],
        });
      }

      if (m.kind === "flow_meter" && m.metric_category && m.metric_interval) {
        addMetric(
          out,
          ids,
          `Flow Volume - ${m.label}`,
          m.metric_category || CATEGORY.FLOW_VOLUME,
          m.metric_unit || "m³",
          pid,
          m.metric_interval || INTERVAL.QH,
          ["raw_data"],
          SOURCE.SENSOR,
          m.metric_storage_table ?? 68,
          null
        );
      }
    }

    return JSON.stringify(out, null, indent);
  }

  // Case 2: object {zones:[...]} or legacy {zone, meters}
  if (!isFixtureArray(input) && input && typeof input === "object") {
    const zonesToBuild: ZoneSeed[] = [];

    if (Array.isArray(input.zones) && input.zones.length > 0) {
      for (const z of input.zones) {
        if (!z || !z.label || !Array.isArray(z.polygon)) continue;
        const meters: MeterSeed[] = Array.isArray(z.meters)
          ? z.meters
              .filter(
                (m: any) => m && m.kind && m.label && Array.isArray(m.coord)
              )
              .map((m: any) => ({
                kind: m.kind,
                label: String(m.label),
                coord: m.coord,
                AZP: !!m.AZP,
                metric_category: m.metric_category ?? null,
                metric_unit: m.metric_unit ?? null,
                metric_interval: m.metric_interval ?? null,
                metric_storage_table: m.metric_storage_table ?? null,
              }))
          : [];
        zonesToBuild.push({
          label: String(z.label),
          polygon: z.polygon,
          meters,
        });
      }
    } else if (input.zone && Array.isArray(input.zone.polygon)) {
      const meters: MeterSeed[] = Array.isArray(input.meters)
        ? input.meters
            .filter(
              (m: any) => m && m.kind && m.label && Array.isArray(m.coord)
            )
            .map((m: any) => ({
              kind: m.kind,
              label: String(m.label),
              coord: m.coord,
              AZP: !!m.AZP,
              metric_category: m.metric_category ?? null,
              metric_unit: m.metric_unit ?? null,
              metric_interval: m.metric_interval ?? null,
              metric_storage_table: m.metric_storage_table ?? null,
            }))
        : [];
      zonesToBuild.push({
        label: String(input.zone.label ?? "Zone"),
        polygon: input.zone.polygon,
        meters,
      });
    }

    if (zonesToBuild.length === 0) {
      return JSON.stringify(out, null, indent);
    }

    for (const zone of zonesToBuild) {
      buildZoneSuite(out, ids, zone, fullZoneSuite);
    }
    return JSON.stringify(out, null, indent);
  }

  // Case 3: already fixture array -> passthrough
  return JSON.stringify(out, null, indent);
}
