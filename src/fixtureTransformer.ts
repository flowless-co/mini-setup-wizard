// src/fixtureTransformer.ts
export type InputItem = {
  category: "flow_meter" | "pressure_sensor" | "zone" | string;
  coords: any; // [x,y] for point OR polygon rings for zone
  label: string;
  inletFor?: string | null;
  outletFor?: string | null;

  // Metric overrides
  metric_unit?: string | null;
  metric_interval?: string | null;
  metric_category?: string | null;
  metric_storage_table?: number | null;

  // Target (Point/Polygon) extras (optional; will be defaulted if omitted)
  notes?: string | null;
  attribute?: any; // { metadata: [...], icon_code: "...", icon_size: 1 }
  tags_list?: any[] | null; // for targets ONLY, array (not string)
};

const DEFAULT_STORAGE_TABLE: number | null = 60; // sensor/raw ContentType.id
const DEFAULT_FORMULA_STORAGE_TABLE = 68; // formula/derived ContentType.id

export type FixtureRow = {
  model: string;
  pk: string | number;
  fields: Record<string, any>;
};

const MODEL = {
  Point: "fl_monitoring.point",
  Polygon: "fl_monitoring.polygon",
  Metric: "fl_monitoring.metricdefinition",
  Link: "fl_monitoring.link",
  Trigger: "fl_dispatcher.metrictrigger",
} as const;

const PREFIX = {
  point: "p",
  polygon: "pl",
  metric: "m",
  trigger: "t",
} as const;

// ---------- Deterministic IDs ----------
function stableId(
  prefix: string,
  parts: (string | number | null | undefined)[]
): string {
  const key = parts.map((p) => (p == null ? "" : String(p))).join("|");
  const s = `${prefix}::${key}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  let hex8 = (h >>> 0).toString(16);
  while (hex8.length < 8) hex8 = "0" + hex8;
  const hex12 = (hex8 + hex8).slice(0, 12);
  return `${prefix}-${hex12}`;
}

function _hex8(n: number): string {
  let s = (n >>> 0).toString(16);
  while (s.length < 8) s = "0" + s;
  return s;
}

/** Deterministic UUID-like (no randomness) for calculators[*].calc_args.metric_id */
function stableUuid(parts: (string | number | null | undefined)[]): string {
  const key = parts.map((p) => (p == null ? "" : String(p))).join("|");
  let h1 = 5381,
    h2 = 52711,
    h3 = 33,
    h4 = 1315423911;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 << 5) + h2) ^ (c + 1);
    h3 = ((h3 << 5) + h3) ^ (c + 2);
    h4 = ((h4 << 5) + h4) ^ (c + 3);
  }
  const hex32 = _hex8(h1) + _hex8(h2) + _hex8(h3) + _hex8(h4);
  return (
    hex32.slice(0, 8) +
    "-" +
    hex32.slice(8, 12) +
    "-" +
    hex32.slice(12, 16) +
    "-" +
    hex32.slice(16, 20) +
    "-" +
    hex32.slice(20, 32)
  );
}

// ---------- Small helpers ----------
function defaultIconCodeForCategory(cat: string) {
  switch (cat) {
    case "flow_meter":
      return "Flow_Meter";
    case "pressure_sensor":
      return "Pressure_Sensor";
    case "zone":
      return "Zone";
    default:
      return "Device";
  }
}

// ---------- Geometry: point-in-polygon (ray casting) ----------
/** Normalize Polygon/MultiPolygon-like coords to a single outer ring */
function outerRing(coords: any): number[][] {
  // Accept:
  //  Polygon: [ [ [x,y], ... ] ]
  //  MultiPolygon: [ [ [ [x,y], ... ] ], ... ]
  if (!Array.isArray(coords)) return [];
  // Polygon → take first ring
  if (
    coords.length > 0 &&
    Array.isArray(coords[0]) &&
    Array.isArray(coords[0][0]) &&
    typeof coords[0][0][0] === "number"
  ) {
    return coords[0] as number[][];
  }
  // MultiPolygon → take first polygon's first ring
  if (
    coords.length > 0 &&
    Array.isArray(coords[0]) &&
    Array.isArray(coords[0][0]) &&
    Array.isArray(coords[0][0][0])
  ) {
    return coords[0][0] as number[][];
  }
  return [];
}

function pointInRing(point: number[], ring: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi; // avoid /0
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: number[], polyCoords: any): boolean {
  const ring = outerRing(polyCoords);
  return ring.length >= 3 ? pointInRing(point, ring) : false;
}

export function buildFixture(input: unknown): FixtureRow[] {
  if (!Array.isArray(input)) {
    throw new Error("Input must be an array of items.");
  }

  const rows: FixtureRow[] = [];

  // Lookups we’ll need
  const labelToTargetId = new Map<string, string>();
  const zoneLabels = new Set<string>();
  const zoneGeoms = new Map<string, any>(); // label -> coords
  const pointCoordsByLabel = new Map<string, number[]>(); // label -> [x,y]

  // Reading metrics we create first
  const flowReadingMetricByLabel = new Map<string, string>(); // label -> m-...
  const flowReadingMetaByLabel = new Map<
    string,
    { unit: string; interval: string }
  >();
  const pressureReadingMetricByLabel = new Map<string, string>();
  const pressureReadingMetaByLabel = new Map<
    string,
    { unit: string; interval: string }
  >();

  // Flow Volume metrics (derived from flow readings)
  const flowVolumeMetricByLabel = new Map<string, string>();

  // ---------- 1) Targets: Points / Polygons ----------
  for (const raw of input) {
    const item = raw as InputItem;
    if (!item || !item.category || !item.label) {
      throw new Error("Each item must include at least { category, label }.");
    }
    const cat = String(item.category).toLowerCase();

    if (cat === "zone") {
      const pk = stableId(PREFIX.polygon, ["zone", item.label]);

      const fields = {
        id: pk,
        tags: "[]", // text
        coord: item.coords, // polygon coordinates array
        label: item.label,
        notes: item.notes ?? item.label,
        coords: JSON.stringify(item.coords, null, 2), // pretty string
        category: "zone",
        attribute: item.attribute ?? {
          metadata: [],
          icon_code: defaultIconCodeForCategory("zone"),
          icon_size: 1,
        },
        is_active: true,
        tags_list: Array.isArray(item.tags_list) ? item.tags_list : [],
      };

      rows.push({ model: MODEL.Polygon, pk, fields });
      labelToTargetId.set(item.label, pk);
      zoneLabels.add(item.label);
      zoneGeoms.set(item.label, item.coords);
    } else {
      // flow_meter / pressure_sensor (point-like)
      const pk = stableId(PREFIX.point, [
        cat,
        item.label,
        ...(Array.isArray(item.coords) ? item.coords : []),
      ]);

      const pointArray = Array.isArray(item.coords)
        ? item.coords
        : [null, null];
      const coordsString =
        pointArray.length >= 2 &&
        typeof pointArray[0] === "number" &&
        typeof pointArray[1] === "number"
          ? `${pointArray[0]}, ${pointArray[1]}`
          : "";

      const fields = {
        id: pk,
        tags: "[]", // text
        coord: pointArray, // [x, y]
        label: item.label,
        notes: item.notes ?? item.label,
        coords: coordsString, // "x, y"
        category: cat,
        attribute: item.attribute ?? {
          metadata: [],
          icon_code: defaultIconCodeForCategory(cat),
          icon_size: 1,
        },
        is_active: true,
        tags_list: Array.isArray(item.tags_list) ? item.tags_list : [],
      };

      rows.push({ model: MODEL.Point, pk, fields });
      labelToTargetId.set(item.label, pk);

      if (
        Array.isArray(pointArray) &&
        pointArray.length >= 2 &&
        typeof pointArray[0] === "number" &&
        typeof pointArray[1] === "number"
      ) {
        pointCoordsByLabel.set(item.label, pointArray);
      }
    }
  }

  // ---------- 2) Metrics: only for flow_meter / pressure_sensor ----------
  for (const raw of input) {
    const item = raw as InputItem;
    const cat = String(item.category || "").toLowerCase();
    if (!(cat === "flow_meter" || cat === "pressure_sensor")) continue;

    const targetId = labelToTargetId.get(item.label);
    if (!targetId) continue;

    const metricCategory = (
      item.metric_category ||
      (cat === "flow_meter" ? "flow_reading" : "pressure_reading")
    ).toString();

    const defaultUnit = cat === "flow_meter" ? "m³" : "m";
    const unit = (item.metric_unit ?? defaultUnit).toString();
    const interval = (item.metric_interval ?? "IRREGULAR").toString();
    const metricLabel = `${metricCategory} - ${item.label}`;

    const pk = stableId(PREFIX.metric, [
      metricCategory,
      item.label,
      unit,
      interval,
    ]);

    const storage_table = item.metric_storage_table ?? DEFAULT_STORAGE_TABLE;
    if (storage_table == null) {
      throw new Error(
        `Metric for "${item.label}" is missing storage_table. ` +
          `Set DEFAULT_STORAGE_TABLE or provide metric_storage_table in input.`
      );
    }

    rows.push({
      model: MODEL.Metric,
      pk,
      fields: {
        label: metricLabel,
        category: metricCategory,
        unit,
        interval,
        tags_list: '["raw_data"]', // stringified list for MetricDefinition
        target_id: targetId,
        storage_table, // FK to ContentType.id (integer)

        args: null,
        tags: "",
        factor: "1.00000000",
        offset: "0E-8",
        source: "SENSOR",
        data_type: "ANALOG",
        describes: interval,
        value_range: "[]",
        is_optimized: false,
        aggregation_type: "gauge",
        pulse_round_down: false,
        histogram_interval: { days: 0, hours: 0, minutes: 0 },
      },
    });

    if (metricCategory === "flow_reading") {
      flowReadingMetricByLabel.set(item.label, pk);
      flowReadingMetaByLabel.set(item.label, { unit, interval });
    }
    if (metricCategory === "pressure_reading") {
      pressureReadingMetricByLabel.set(item.label, pk);
      pressureReadingMetaByLabel.set(item.label, { unit, interval });
    }
  }

  // ---------- 3) Links: device ↔ zone (create 2 if inlet & outlet) ----------
  let nextLinkPk = 1; // PKs must be integers
  for (const raw of input) {
    const item = raw as InputItem;
    const cat = String(item.category || "").toLowerCase();
    if (!(cat === "flow_meter" || cat === "pressure_sensor")) continue;

    const deviceId = labelToTargetId.get(item.label);
    if (!deviceId) continue;

    if (item.inletFor && zoneLabels.has(item.inletFor)) {
      const zoneId = labelToTargetId.get(item.inletFor)!;
      rows.push({
        model: MODEL.Link,
        pk: nextLinkPk++,
        fields: {
          args: { role: ["inlet"], order: null },
          notes: "",
          target_id1: deviceId,
          target_id2: zoneId,
          relation_type: "flow_meter_in_zone",
        },
      });
    }

    if (item.outletFor && zoneLabels.has(item.outletFor)) {
      const zoneId = labelToTargetId.get(item.outletFor)!;
      rows.push({
        model: MODEL.Link,
        pk: nextLinkPk++,
        fields: {
          args: { role: ["outlet"], order: null },
          notes: "",
          target_id1: deviceId,
          target_id2: zoneId,
          relation_type: "flow_meter_in_zone",
        },
      });
    }
  }

  // ---------- 4) Flow Volume: per flow meter → create metric + trigger ----------
  flowReadingMetricByLabel.forEach((readingMetricId, lbl) => {
    const meta = flowReadingMetaByLabel.get(lbl) || {
      unit: "m³",
      interval: "IRREGULAR",
    };
    const deviceId = labelToTargetId.get(lbl);
    if (!deviceId) return;

    const volumeMetricId = stableId(PREFIX.metric, [
      "flow_volume",
      lbl,
      meta.unit,
      meta.interval,
    ]);

    rows.push({
      model: MODEL.Metric,
      pk: volumeMetricId,
      fields: {
        label: `Flow Volume - ${lbl}`,
        category: "flow_volume",
        unit: meta.unit,
        interval: meta.interval,
        tags_list: '["raw_data"]',
        target_id: deviceId,
        storage_table: DEFAULT_FORMULA_STORAGE_TABLE,
        args: {},
        tags: "",
        factor: "1.00000000",
        offset: "0E-8",
        source: "FORMULA",
        data_type: "ANALOG",
        describes: meta.interval,
        value_range: "[]",
        is_optimized: false,
        aggregation_type: "gauge",
        pulse_round_down: false,
        histogram_interval: null,
      },
    });

    flowVolumeMetricByLabel.set(lbl, volumeMetricId);

    // Flow Volume trigger now CALCULATE_DELTA
    const trigId = stableId(PREFIX.trigger, ["flow_volume", lbl]);
    rows.push({
      model: MODEL.Trigger,
      pk: trigId,
      fields: {
        id: trigId,
        caller: "REAL_TIME",
        is_active: true,
        calculator: "",
        calculators: [
          {
            calc_args: {
              inputs: {},
              metric_id: stableUuid(["flow_volume", lbl]),
            },
            calc_name: "CALCULATE_DELTA",
          },
        ],
        description: `Flow Volume - ${lbl}`,
        schedule_job: "",
        input_metrics: [readingMetricId],
        output_metric: volumeMetricId,
      },
    });
  });

  // Build zone → inputs
  const zoneToFlowVolumeInputs = new Map<string, string[]>(); // zone -> [m-...]
  const zoneToPressureInputs = new Map<string, string[]>(); // zone -> [m-...]

  zoneLabels.forEach((zlbl) => {
    const zcoords = zoneGeoms.get(zlbl);
    const flowVols: string[] = [];
    const pressReads: string[] = [];

    pointCoordsByLabel.forEach((pt, lbl) => {
      if (!Array.isArray(pt)) return;
      if (!pointInPolygon(pt, zcoords)) return;

      const fv = flowVolumeMetricByLabel.get(lbl);
      if (fv) flowVols.push(fv);

      const pr = pressureReadingMetricByLabel.get(lbl);
      if (pr) pressReads.push(pr);
    });

    if (flowVols.length) zoneToFlowVolumeInputs.set(zlbl, flowVols);
    if (pressReads.length) zoneToPressureInputs.set(zlbl, pressReads);
  });

  // ---------- 5) Zone Demand: per zone (inputs = flow volumes in zone) ----------
  const AGG_GROUPS = ["year", "month", "day", "hour", "quarter_hour"];

  zoneToFlowVolumeInputs.forEach((inputMetricIds, zlbl) => {
    const zoneId = labelToTargetId.get(zlbl);
    if (!zoneId) return;

    const zMetricId = stableId(PREFIX.metric, [
      "zone_demand",
      zlbl,
      "m³",
      "QUARTER_HOUR",
    ]);

    rows.push({
      model: MODEL.Metric,
      pk: zMetricId,
      fields: {
        label: `${zlbl} - Demand`,
        category: "zone_demand",
        unit: "m³",
        interval: "QUARTER_HOUR",
        tags_list: '["sum_aggregated"]',
        target_id: zoneId,
        storage_table: DEFAULT_FORMULA_STORAGE_TABLE,
        args: {},
        tags: "",
        factor: "1.00000000",
        offset: "0E-8",
        source: "FORMULA",
        data_type: "ANALOG",
        describes: "QUARTER_HOUR",
        value_range: "[]",
        is_optimized: false,
        aggregation_type: "gauge",
        pulse_round_down: false,
        histogram_interval: null,
      },
    });

    const trigId = stableId(PREFIX.trigger, ["zone_demand", zlbl]);
    rows.push({
      model: MODEL.Trigger,
      pk: trigId,
      fields: {
        id: trigId,
        caller: "REAL_TIME",
        is_active: true,
        calculator: "",
        calculators: [
          {
            calc_args: {
              inputs: {},
              metric_id: stableUuid(["zone_demand", zlbl]),
              aggregation_groups: AGG_GROUPS,
              use_histogram_interval: false,
            },
            calc_name: "CALCULATE_ZONE_DEMAND",
          },
        ],
        description: `${zlbl} - Demand`,
        schedule_job: "",
        input_metrics: inputMetricIds,
        output_metric: zMetricId,
      },
    });
  });

  // ---------- 6) AZP: per zone ----------
  zoneToPressureInputs.forEach((inputMetricIds, zlbl) => {
    const zoneId = labelToTargetId.get(zlbl);
    if (!zoneId) return;

    const azpMetricId = stableId(PREFIX.metric, [
      "average_zone_pressure",
      zlbl,
      "bar",
      "QUARTER_HOUR",
    ]);

    rows.push({
      model: MODEL.Metric,
      pk: azpMetricId,
      fields: {
        args: {},
        tags: "",
        unit: "bar",
        label: `${zlbl} - Average zone pressure`,
        factor: "1.00000000",
        offset: "0E-8",
        source: "FORMULA",
        category: "average_zone_pressure",
        interval: "QUARTER_HOUR",
        data_type: "ANALOG",
        describes: "QUARTER_HOUR",
        tags_list: '["raw_data"]',
        target_id: zoneId,
        value_range: "[]",
        is_optimized: false,
        storage_table: DEFAULT_FORMULA_STORAGE_TABLE,
        aggregation_type: "gauge",
        pulse_round_down: false,
        histogram_interval: null,
      },
    });

    const trigId = stableId(PREFIX.trigger, ["azp", zlbl]);
    rows.push({
      model: MODEL.Trigger,
      pk: trigId,
      fields: {
        id: trigId,
        caller: "REAL_TIME",
        is_active: true,
        calculator: "",
        calculators: [
          {
            calc_args: {
              inputs: {},
              metric_id: stableUuid(["azp", zlbl]),
            },
            calc_name: "CALCULATE_AVG", // fixed
          },
        ],
        description: `${zlbl} - Average Zone Pressure`,
        schedule_job: null,
        input_metrics: inputMetricIds,
        output_metric: azpMetricId,
      },
    });
  });

  return rows;
}

export function buildFixtureJson(input: unknown, indent = 2): string {
  return JSON.stringify(buildFixture(input), null, indent);
}
