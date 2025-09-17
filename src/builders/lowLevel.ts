/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  FixtureItem,
  AuthorV2,
  ExtraMetricConfig,
  ExtraMetricKind,
} from "../types";

/** ---------- ID helpers ---------- **/
function hex12(): string {
  const ts = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(6, "0");
  const rnd = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return (ts + rnd).slice(0, 12);
}
function gen(prefix: "m" | "t" | "p" | "pl"): string {
  return `${prefix}-${hex12()}`;
}
// Global numeric PK for links to avoid collisions across zones
let linkSeq = 0;

/** ---------- Deterministic calc metric_id helper ---------- **/
function h32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function calcMetricId(seed: string): string {
  const a = h32(seed + "#1");
  const b = h32(seed + "#2", 0x12345678);
  const c = h32(seed + "#3", 0x9e3779b9);
  const d = h32(seed + "#4", 0x7f4a7c15);
  const part = (x: number) => x.toString(16).padStart(8, "0");
  return `${part(a)}-${part(b)}-${part(c)}-${part(d)}`;
}

/** ---------- geometry & interval helpers ---------- **/
type Coord = [number, number];
type Ring = Coord[];
type Polygon = Ring[];

function toCoord(v: any): Coord {
  if (Array.isArray(v) && v.length >= 2) return [Number(v[0]), Number(v[1])];
  throw new Error("Bad coord");
}
function toPolygon(v: any): Polygon {
  if (!Array.isArray(v) || v.length === 0) throw new Error("Bad polygon");
  if (Array.isArray(v[0]) && typeof v[0][0] === "number") return [v as Ring];
  return v as Polygon;
}

const INTERVAL_RANK: Record<string, number> = {
  QUARTER_HOUR: 0,
  HOURLY: 1,
  DAILY: 2,
};
function rankInterval(iv: string): number {
  return INTERVAL_RANK[String(iv).toUpperCase()] ?? 0;
}
function aggGroupsForInterval(toInterval: string): string[] {
  const up = String(toInterval).toUpperCase();
  if (up === "HOURLY") return ["HOUR"];
  if (up === "DAILY") return ["DAY"];
  return [];
}
function minutesForInterval(interval: string): number {
  const up = String(interval).toUpperCase();
  if (up === "QUARTER_HOUR") return 15;
  if (up === "HOURLY") return 60;
  if (up === "DAILY") return 1440;
  // default to quarter-hour if unknown
  return 15;
}

/** ---------- compilation indexes ---------- **/
type MeterIdx = {
  pointId: string;
  unit: string;
  interval: string;
  label: string;
  // optional based on meter type:
  readingMetricId?: string;
  volumeMetricId?: string;
  rateMetricId?: string;
  extras?: Partial<Record<ExtraMetricKind, string>>;
};
type PressureIdx = {
  pointId: string;
  pressureMetricId: string;
  unit: string;
  interval: string;
  label: string;
  extras?: Partial<Record<ExtraMetricKind, string>>;
};
type ZoneIdx = {
  polygonId: string;
  label: string;
};

type Ctx = {
  out: FixtureItem[];
  metersByLabel: Map<string, MeterIdx>;
  pressureByLabel: Map<string, PressureIdx>;
  zonesByLabel: Map<string, ZoneIdx>;
};

/** ---------- main ---------- **/
export function buildLowLevel(input: AuthorV2[]): FixtureItem[] {
  const ctx: Ctx = {
    out: [],
    metersByLabel: new Map(),
    pressureByLabel: new Map(),
    zonesByLabel: new Map(),
  };

  // Pass 1: targets + direct metrics
  // TODO: Make it dynamic to be able to accept variance of unusual categories
  for (const node of input) {
    if (node.type === "flowMeterWithReading") {
      compileFlowMeterWithReading(ctx, node);
    } else if (node.type === "flowMeterWithVolume") {
      compileFlowMeterWithVolume(ctx, node);
    } else if (node.type === "flowMeterWithRate") {
      compileFlowMeterWithRate(ctx, node);
    } else if (node.type === "pressureSensor") {
      compilePressureSensor(ctx, node);
    } else if (node.type === "zone") {
      compileZoneTarget(ctx, node);
    }
  }

  // Pass 2: wiring (zones)
  for (const node of input) {
    if (node.type !== "zone") continue;
    wireZoneDependencies(ctx, node);
  }

  return ctx.out;
}

/** ---------- emit extra metrics (battery / signal / status) ---------- **/
function emitExtraMetrics(
  ctx: Ctx,
  pointId: string,
  deviceLabel: string,
  extras: ExtraMetricConfig[] | undefined,
  _fallbackInterval: string
): Partial<Record<ExtraMetricKind, string>> | undefined {
  if (!extras || extras.length === 0) return undefined;

  const out: Partial<Record<ExtraMetricKind, string>> = {};

  for (const cfg of extras) {
    const kind = cfg.kind;
    const interval = cfg.interval ?? "HOURLY";
    const label = cfg.label ?? defaultExtraLabel(kind, deviceLabel);

    let category: string;
    let unit = cfg.unit;
    // Defaults per kind
    if (kind === "battery") {
      category = "battery_level";
      unit = unit ?? "%";
    } else if (kind === "signal") {
      category = "signal_strength";
      unit = unit ?? "dBm";
    } else {
      category = "status";
      unit = unit ?? "";
    }

    const mId = gen("m");
    ctx.out.push({
      model: "fl_monitoring.metricdefinition",
      pk: mId,
      fields: {
        factor: 1,
        offset: 0,
        source: "SENSOR",
        data_type: "ANALOG",
        value_range: [],
        is_optimized: false,
        storage_table: 68,
        aggregation_type: "gauge",
        pulse_round_down: false,
        histogram_interval: null,
        unit,
        label,
        category,
        interval,
        describes: interval,
        tags_list: cfg.tags ?? ["raw_data"],
        target_id: pointId,
        id: mId,
      },
    });

    out[kind] = mId;
  }

  return Object.keys(out).length ? out : undefined;
}

function defaultExtraLabel(kind: ExtraMetricKind, deviceLabel: string): string {
  if (kind === "battery") return `Battery – ${deviceLabel}`;
  if (kind === "signal") return `Signal – ${deviceLabel}`;
  return `Status – ${deviceLabel}`;
}

/** ---------- handlers ---------- **/

// 1) flowMeterWithReading → point + flow_reading + flow_volume + DELTA trigger (+extras)
function compileFlowMeterWithReading(
  ctx: Ctx,
  n: Extract<AuthorV2, { type: "flowMeterWithReading" }>
) {
  const pId = gen("p");
  const coord = toCoord(n.coords);
  ctx.out.push({
    model: "fl_monitoring.point",
    pk: pId,
    fields: {
      id: pId,
      tags: "[]",
      coord,
      label: n.label,
      notes: n.label,
      category: "flow_meter",
    },
  });

  // flow_reading
  const mRead = gen("m");
  ctx.out.push({
    model: "fl_monitoring.metricdefinition",
    pk: mRead,
    fields: {
      factor: 1,
      offset: 0,
      source: "SENSOR",
      data_type: "ANALOG",
      value_range: [],
      is_optimized: false,
      storage_table: 68,
      aggregation_type: "gauge",
      pulse_round_down: false,
      histogram_interval: null,
      unit: n.unit,
      label: `Flow Reading – ${n.label}`,
      category: "flow_reading",
      interval: n.interval,
      describes: n.interval,
      tags_list: ["raw_data"],
      target_id: pId,
      id: mRead,
    },
  });

  // flow_volume (formula from delta)
  const mVol = gen("m");
  ctx.out.push({
    model: "fl_monitoring.metricdefinition",
    pk: mVol,
    fields: {
      factor: 1,
      offset: 0,
      source: "FORMULA",
      data_type: "ANALOG",
      value_range: [],
      is_optimized: false,
      storage_table: 68,
      aggregation_type: "gauge",
      pulse_round_down: false,
      histogram_interval: null,
      unit: n.unit,
      label: `Flow Volume – ${n.label}`,
      category: "flow_volume",
      interval: n.interval,
      describes: n.interval,
      tags_list: ["sum_aggregated"],
      target_id: pId,
      id: mVol,
    },
  });

  // DELTA(reading) → volume
  const t = gen("t");
  ctx.out.push({
    model: "fl_dispatcher.metrictrigger",
    pk: t,
    fields: {
      id: t,
      caller: "REAL_TIME",
      is_active: true,
      calculator: "",
      calculators: [
        {
          calc_name: "CALCULATE_DELTA",
          calc_args: {
            inputs: {},
            time_range_type: "operation",
            metric_id: calcMetricId(`${mVol}|CALCULATE_DELTA|${n.label}`),
          },
        },
      ],
      description: `Flow Volume – ${n.label}`,
      schedule_job: "",
      input_metrics: [mRead],
      output_metric: mVol,
    },
  });

  const extras = emitExtraMetrics(ctx, pId, n.label, n.extras, n.interval);

  ctx.metersByLabel.set(n.label, {
    pointId: pId,
    readingMetricId: mRead,
    volumeMetricId: mVol,
    unit: n.unit,
    interval: n.interval,
    label: n.label,
    extras,
  });
}

// 2) flowMeterWithVolume → point + flow_volume (+extras)
function compileFlowMeterWithVolume(
  ctx: Ctx,
  n: Extract<AuthorV2, { type: "flowMeterWithVolume" }>
) {
  const pId = gen("p");
  const coord = toCoord(n.coords);
  ctx.out.push({
    model: "fl_monitoring.point",
    pk: pId,
    fields: {
      id: pId,
      tags: "[]",
      coord,
      label: n.label,
      notes: n.label,
      category: "flow_meter",
    },
  });

  const mVol = gen("m");
  ctx.out.push({
    model: "fl_monitoring.metricdefinition",
    pk: mVol,
    fields: {
      factor: 1,
      offset: 0,
      source: "SENSOR", // direct volume
      data_type: "ANALOG",
      value_range: [],
      is_optimized: false,
      storage_table: 68,
      aggregation_type: "gauge",
      pulse_round_down: false,
      histogram_interval: null,
      unit: n.unit,
      label: `Flow Volume – ${n.label}`,
      category: "flow_volume",
      interval: n.interval,
      describes: n.interval,
      tags_list: ["sum_aggregated"],
      target_id: pId,
      id: mVol,
    },
  });

  const extras = emitExtraMetrics(ctx, pId, n.label, n.extras, n.interval);

  ctx.metersByLabel.set(n.label, {
    pointId: pId,
    volumeMetricId: mVol,
    unit: n.unit,
    interval: n.interval,
    label: n.label,
    extras,
  });
}

// 3) flowMeterWithRate → point + flow_rate (+extras)
function compileFlowMeterWithRate(
  ctx: Ctx,
  n: Extract<AuthorV2, { type: "flowMeterWithRate" }>
) {
  const pId = gen("p");
  const coord = toCoord(n.coords);
  ctx.out.push({
    model: "fl_monitoring.point",
    pk: pId,
    fields: {
      id: pId,
      tags: "[]",
      coord,
      label: n.label,
      notes: n.label,
      category: "flow_meter",
    },
  });

  const mRate = gen("m");
  ctx.out.push({
    model: "fl_monitoring.metricdefinition",
    pk: mRate,
    fields: {
      factor: 1,
      offset: 0,
      source: "SENSOR",
      data_type: "ANALOG",
      value_range: [],
      is_optimized: false,
      storage_table: 68,
      aggregation_type: "gauge",
      pulse_round_down: false,
      histogram_interval: null,
      unit: n.unit,
      label: `Flow Rate – ${n.label}`,
      category: "flow_rate",
      interval: n.interval,
      describes: n.interval,
      tags_list: ["raw_data"],
      target_id: pId,
      id: mRate,
    },
  });

  const extras = emitExtraMetrics(ctx, pId, n.label, n.extras, n.interval);

  ctx.metersByLabel.set(n.label, {
    pointId: pId,
    rateMetricId: mRate,
    unit: n.unit,
    interval: n.interval,
    label: n.label,
    extras,
  });
}

// 4) pressureSensor → point + pressure (+extras)
function compilePressureSensor(
  ctx: Ctx,
  n: Extract<AuthorV2, { type: "pressureSensor" }>
) {
  const pId = gen("p");
  const coord = toCoord(n.coords);
  ctx.out.push({
    model: "fl_monitoring.point",
    pk: pId,
    fields: {
      id: pId,
      tags: "[]",
      coord,
      label: n.label,
      notes: n.label,
      category: "pressure_sensor",
    },
  });

  const mP = gen("m");
  ctx.out.push({
    model: "fl_monitoring.metricdefinition",
    pk: mP,
    fields: {
      factor: 1,
      offset: 0,
      source: "SENSOR",
      data_type: "ANALOG",
      value_range: [],
      is_optimized: false,
      storage_table: 68,
      aggregation_type: "gauge",
      pulse_round_down: false,
      histogram_interval: null,
      unit: n.unit,
      label: `Pressure – ${n.label}`,
      category: "pressure",
      interval: n.interval,
      describes: n.interval,
      tags_list: ["raw_data"],
      target_id: pId,
      id: mP,
    },
  });

  const extras = emitExtraMetrics(ctx, pId, n.label, n.extras, n.interval);

  ctx.pressureByLabel.set(n.label, {
    pointId: pId,
    pressureMetricId: mP,
    unit: n.unit,
    interval: n.interval,
    label: n.label,
    extras,
  });
}

// 5) zone → polygon
function compileZoneTarget(ctx: Ctx, n: Extract<AuthorV2, { type: "zone" }>) {
  const plId = gen("pl");
  const poly = toPolygon(n.coords);
  ctx.out.push({
    model: "fl_monitoring.polygon",
    pk: plId,
    fields: {
      id: plId,
      tags: "[]",
      coord: poly[0],
      label: n.label,
      notes: n.label,
      coords: JSON.stringify(poly),
      category: "zone",
    },
  });
  ctx.zonesByLabel.set(n.label, { polygonId: plId, label: n.label });
}

/** ---------- wiring: inlets/links, normalization, zone demand(+QH), azp, cpp ---------- **/
function wireZoneDependencies(
  ctx: Ctx,
  n: Extract<AuthorV2, { type: "zone" }>
) {
  const z = ctx.zonesByLabel.get(n.label);
  if (!z) return;

  // Inlet links (accept any meter type)
  const inletMeters: MeterIdx[] = [];
  for (const ref of n.inlets ?? []) {
    const lab = parseRefMulti(ref, [
      "flowMeterWithReading",
      "flowMeterWithVolume",
      "flowMeterWithRate",
    ]);
    if (!lab) continue;
    const m = ctx.metersByLabel.get(lab);
    if (!m) continue;

    const id = ++linkSeq;
    ctx.out.push({
      model: "fl_monitoring.link",
      pk: id,
      fields: {
        id,
        args: { role: ["inlet"], order: null },
        notes: "",
        target_id1: m.pointId,
        target_id2: z.polygonId,
        relation_type: "flow_meter_in_zone",
      },
    });
    inletMeters.push(m);
  }

  const wantsZoneDemand = (n.metricAbstractionId ?? []).includes(
    "MetricCategory.zoneDemand"
  );
  const wantsAZP = (n.metricAbstractionId ?? []).includes("MetricCategory.azp");

  // ---- FLOW VOLUME NORMALIZATION (within this zone) ----
  // Only meters that actually have a volume metric participate in zone demand.
  const volumeMeters = inletMeters.filter((m) => !!m.volumeMetricId);
  let normalizedVolumeIds: string[] = [];

  let highestInterval = "QUARTER_HOUR";
  if (volumeMeters.length > 0) {
    highestInterval = volumeMeters[0].interval;
    for (const m of volumeMeters) {
      if (rankInterval(m.interval) > rankInterval(highestInterval)) {
        highestInterval = m.interval;
      }
    }

    // For each meter: if its volume interval is lower, up-aggregate to highestInterval
    for (const m of volumeMeters) {
      const curr = m.interval;
      const sameInterval = rankInterval(curr) === rankInterval(highestInterval);

      if (sameInterval) {
        // Already at the highest interval; use the original volume metric
        normalizedVolumeIds.push(m.volumeMetricId!);
      } else {
        // Create a normalized flow_volume metric at the highest interval
        const mNorm = gen("m");
        ctx.out.push({
          model: "fl_monitoring.metricdefinition",
          pk: mNorm,
          fields: {
            factor: 1,
            offset: 0,
            source: "FORMULA",
            data_type: "ANALOG",
            value_range: [],
            is_optimized: false,
            storage_table: 68,
            aggregation_type: "gauge",
            pulse_round_down: false,
            histogram_interval: null,
            unit: m.unit,
            label: `Flow Volume (${highestInterval}) – ${m.label}`,
            category: "flow_volume",
            interval: highestInterval,
            describes: highestInterval,
            tags_list: ["sum_aggregated"],
            target_id: m.pointId,
            id: mNorm,
          },
        });

        // Trigger: SUM (curr -> highest) using aggregation_groups
        const tNorm = gen("t");
        ctx.out.push({
          model: "fl_dispatcher.metrictrigger",
          pk: tNorm,
          fields: {
            id: tNorm,
            caller: "REAL_TIME",
            is_active: true,
            calculator: "",
            calculators: [
              {
                calc_name: "CALCULATE_SUM",
                calc_args: {
                  inputs: {},
                  time_range_type: "operation",
                  aggregation_groups: aggGroupsForInterval(highestInterval),
                  metric_id: calcMetricId(
                    `${mNorm}|CALCULATE_SUM|${m.label}|${curr}->${highestInterval}`
                  ),
                },
              },
            ],
            description: `Normalize Flow Volume ${curr}→${highestInterval} – ${m.label}`,
            schedule_job: "",
            input_metrics: [m.volumeMetricId!],
            output_metric: mNorm,
          },
        });

        normalizedVolumeIds.push(mNorm);
      }
    }
  }

  // ---- ZONE DEMAND (uses normalized volumes) ----
  if (wantsZoneDemand && normalizedVolumeIds.length > 0) {
    // Base / highest interval among inlet volumes
    const baseIv = highestInterval;
    const baseIvUp = String(baseIv).toUpperCase();

    const baseMeter =
      volumeMeters.find(
        (m) => rankInterval(m.interval) === rankInterval(baseIv)
      ) ?? volumeMeters[0];

    // Label & tags per your rule:
    // - if QUARTER_HOUR → "Zone Demand – Zone", tags ["raw_data"]
    // - else             → "{INTERVAL} - demand - {Zone}", tags ["sum_aggregated"]
    const isQH = baseIvUp === "QUARTER_HOUR";
    const demandLabel = isQH
      ? `Zone Demand – ${n.label}`
      : `${baseIvUp} - demand - ${n.label}`;
    const demandTags = isQH ? ["raw_data"] : ["sum_aggregated"];

    // Zone demand metric at base interval
    const mZd = gen("m");
    ctx.out.push({
      model: "fl_monitoring.metricdefinition",
      pk: mZd,
      fields: {
        factor: 1,
        offset: 0,
        source: "FORMULA",
        data_type: "ANALOG",
        value_range: [],
        is_optimized: false,
        storage_table: 68,
        aggregation_type: "gauge",
        pulse_round_down: false,
        histogram_interval: null,
        unit: baseMeter.unit,
        label: demandLabel,
        category: "zone_demand",
        interval: baseIv,
        describes: baseIv,
        tags_list: demandTags,
        target_id: z.polygonId,
        id: mZd,
      },
    });

    const tZd = gen("t");
    ctx.out.push({
      model: "fl_dispatcher.metrictrigger",
      pk: tZd,
      fields: {
        id: tZd,
        caller: "REAL_TIME",
        is_active: true,
        calculator: "",
        calculators: [
          {
            calc_name: "CALCULATE_ZONE_DEMAND",
            calc_args: {
              inputs: {},
              time_range_type: "operation",
              metric_id: calcMetricId(
                `${mZd}|CALCULATE_ZONE_DEMAND|${n.label}`
              ),
            },
          },
        ],
        description: `Zone Demand – ${n.label}`,
        schedule_job: "",
        input_metrics: normalizedVolumeIds,
        output_metric: mZd,
      },
    });

    // ---- Create QUARTER_HOUR demand if base != QH ----
    if (!isQH) {
      const mZdQH = gen("m");
      ctx.out.push({
        model: "fl_monitoring.metricdefinition",
        pk: mZdQH,
        fields: {
          factor: 1,
          offset: 0,
          source: "FORMULA",
          data_type: "ANALOG",
          value_range: [],
          is_optimized: false,
          storage_table: 68,
          aggregation_type: "gauge",
          pulse_round_down: false,
          histogram_interval: null,
          unit: baseMeter.unit,
          // keep the normal QH label
          label: `Zone Demand – ${n.label}`,
          category: "zone_demand",
          interval: "QUARTER_HOUR",
          describes: "QUARTER_HOUR",
          tags_list: ["raw_data"],
          target_id: z.polygonId,
          id: mZdQH,
        },
      });

      const factor =
        minutesForInterval("QUARTER_HOUR") / minutesForInterval(baseIvUp); // e.g., 15/60 = 0.25

      const tQh = gen("t");
      ctx.out.push({
        model: "fl_dispatcher.metrictrigger",
        pk: tQh,
        fields: {
          id: tQh,
          caller: "REAL_TIME",
          is_active: true,
          calculator: "",
          calculators: [
            {
              calc_name: "CALCULATE_TRANSFORM",
              calc_args: {
                factor,
                inputs: {},
                offset: 0,
                metric_id: calcMetricId(
                  `${mZdQH}|CALCULATE_TRANSFORM|${n.label}|${baseIvUp}->QUARTER_HOUR`
                ),
                time_range_type: "follow",
              },
            },
          ],
          description: `Demand – ${n.label}`,
          schedule_job: "",
          input_metrics: [mZd],
          output_metric: mZdQH,
        },
      });
    }
  }

  // ---- CPP exclusion from AZP ----
  const cppLabel = n.cppSensor
    ? parseRefMulti(n.cppSensor, ["pressureSensor"])
    : null;
  const cppIdx = cppLabel ? ctx.pressureByLabel.get(cppLabel) : undefined;

  let azpList: PressureIdx[] = [];
  if (wantsAZP && (n.azpSensors?.length ?? 0) > 0) {
    const seen = new Set<string>();
    for (const ref of n.azpSensors ?? []) {
      const lab = parseRefMulti(ref, ["pressureSensor"]);
      if (!lab) continue;
      if (seen.has(lab)) continue;
      seen.add(lab);
      const p = ctx.pressureByLabel.get(lab);
      if (p) azpList.push(p);
    }
  }

  // AZP metric + trigger
  if (azpList.length > 0) {
    const base = azpList[0];
    const mAzp = gen("m");
    ctx.out.push({
      model: "fl_monitoring.metricdefinition",
      pk: mAzp,
      fields: {
        factor: 1,
        offset: 0,
        source: "FORMULA",
        data_type: "ANALOG",
        value_range: [],
        is_optimized: false,
        storage_table: 68,
        aggregation_type: "gauge",
        pulse_round_down: false,
        histogram_interval: null,
        unit: base.unit,
        label: `AZP – ${n.label}`,
        category: "average_zone_pressure",
        interval: base.interval,
        describes: base.interval,
        tags_list: ["avg_aggregated"],
        target_id: z.polygonId,
        id: mAzp,
      },
    });

    const tAzp = gen("t");
    ctx.out.push({
      model: "fl_dispatcher.metrictrigger",
      pk: tAzp,
      fields: {
        id: tAzp,
        caller: "REAL_TIME",
        is_active: true,
        calculator: "",
        calculators: [
          {
            calc_name: "CALCULATE_AVG",
            calc_args: {
              inputs: {},
              time_range_type: "operation",
              aggregation_groups: [],
              metric_id: calcMetricId(`${mAzp}|CALCULATE_AVG|${n.label}`),
            },
          },
        ],
        description: `AZP – ${n.label}`,
        schedule_job: "",
        input_metrics: azpList.map((p) => p.pressureMetricId),
        output_metric: mAzp,
      },
    });
  }

  // CPP — metric at CPP sensor point + passthrough AVG (single input)
  if (cppIdx) {
    const mCpp = gen("m");
    ctx.out.push({
      model: "fl_monitoring.metricdefinition",
      pk: mCpp,
      fields: {
        factor: 1,
        offset: 0,
        source: "FORMULA",
        data_type: "ANALOG",
        value_range: [],
        is_optimized: false,
        storage_table: 68,
        aggregation_type: "gauge",
        pulse_round_down: false,
        histogram_interval: null,
        unit: cppIdx.unit,
        label: `CPP – ${cppIdx.label}`,
        category: "critical_point_pressure",
        interval: cppIdx.interval,
        describes: cppIdx.interval,
        tags_list: ["raw_data"],
        target_id: cppIdx.pointId, // attach to the CPP SENSOR POINT
        id: mCpp,
      },
    });

    const tCpp = gen("t");
    ctx.out.push({
      model: "fl_dispatcher.metrictrigger",
      pk: tCpp,
      fields: {
        id: tCpp,
        caller: "REAL_TIME",
        is_active: true,
        calculator: "",
        calculators: [
          {
            calc_name: "CALCULATE_AVG",
            calc_args: {
              inputs: {},
              time_range_type: "operation",
              aggregation_groups: [],
              metric_id: calcMetricId(`${mCpp}|CPP_AVG|${cppIdx.label}`),
            },
          },
        ],
        description: `CPP from ${cppIdx.label}`,
        schedule_job: "",
        input_metrics: [cppIdx.pressureMetricId],
        output_metric: mCpp,
      },
    });
  }
}

/** ---------- ref parsing ---------- **/
function parseRefMulti(
  ref: string,
  expectedTypes: Array<
    | "flowMeterWithReading"
    | "flowMeterWithVolume"
    | "flowMeterWithRate"
    | "pressureSensor"
  >
): string | null {
  if (typeof ref !== "string" || !ref.startsWith("$")) return null;
  const body = ref.slice(1); // e.g., flowMeterWithVolume.M1
  const [type, ...rest] = body.split(".");
  const label = rest.join(".");
  if (!expectedTypes.includes(type as any)) return null;
  return label || null;
}
