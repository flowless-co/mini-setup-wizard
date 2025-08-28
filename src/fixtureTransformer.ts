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

const DEFAULT_STORAGE_TABLE: number | null = 60; // ContentType.id

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
} as const;

const PREFIX = {
  point: "p",
  polygon: "pl",
  metric: "m",
} as const;

// Simple deterministic hash → 12 hex chars (DJB2-based)
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

// Small helpers for defaults
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

export function buildFixture(input: unknown): FixtureRow[] {
  if (!Array.isArray(input)) {
    throw new Error("Input must be an array of items.");
  }

  const rows: FixtureRow[] = [];
  const labelToTargetId = new Map<string, string>();
  const zoneLabels = new Set<string>();

  // ---------- 1) Targets: Points / Polygons ----------
  for (const raw of input) {
    const item = raw as InputItem;
    if (!item || !item.category || !item.label) {
      throw new Error("Each item must include at least { category, label }.");
    }
    const cat = String(item.category).toLowerCase();

    if (cat === "zone") {
      const pk = stableId(PREFIX.polygon, ["zone", item.label]);

      // Polygon fields shaped like your example:
      const fields = {
        id: pk,
        tags: "[]", // text
        coord: item.coords, // polygon coordinates array
        label: item.label,
        notes: item.notes ?? item.label,
        coords: JSON.stringify(item.coords, null, 2), // stringified pretty JSON
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
    } else {
      // Point-like target (flow_meter / pressure_sensor / others)
      const pk = stableId(PREFIX.point, [
        cat,
        item.label,
        ...(Array.isArray(item.coords) ? item.coords : []),
      ]);

      // Point fields shaped like your example:
      // coord: use the [x,y]; coords: a "x, y" string for readability
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
        coords: coordsString, // string "x, y"
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
        // platform-style fields for MetricDefinition:
        tags_list: '["raw_data"]', // stringified list (as you showed)
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
  }

  // ---------- 3) Links: device ↔ zone (create 2 if inlet & outlet) ----------
  // PKs must be integers
  let nextLinkPk = 1;
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

  return rows;
}

export function buildFixtureJson(input: unknown, indent = 2): string {
  return JSON.stringify(buildFixture(input), null, indent);
}
