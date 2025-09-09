/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  InputItem,
  FixtureItem,
  BuildOptions,
  Coord,
  Polygon,
} from "../types";
import { IdRegistry } from "./ids";
import { pointInPolygon } from "./geo";

const DEFAULT_FIELDS = {
  factor: 1,
  offset: 0,
  source: "FORMULA",
  data_type: "ANALOG",
  value_range: [] as any[],
  is_optimized: false,
  storage_table: 68,
  aggregation_type: "gauge",
  pulse_round_down: false,
  histogram_interval: { days: 0, hours: 0, minutes: 0 },
};

// tuple coercers (avoid array->tuple type issues)
function toCoord(v: any): Coord {
  return [Number(v?.[0]), Number(v?.[1])] as Coord;
}
function toPolygon(poly: any): Polygon {
  return (poly ?? []).map((ring: any) =>
    (ring ?? []).map((c: any) => toCoord(c))
  ) as Polygon;
}

export function buildLowLevel(
  input: InputItem[],
  _opts: BuildOptions = {}
): FixtureItem[] {
  const out: FixtureItem[] = [];
  const ids = new IdRegistry();

  const zones: { id: string; label: string; poly: Polygon }[] = [];
  const points: {
    id: string;
    label: string;
    coord: Coord;
    category: string;
  }[] = [];

  const push = (model: string, pk: string | number, fields: any) => {
    out.push({ model, pk, fields });
    return pk;
  };

  // 1) polygons & points
  for (const item of input) {
    if (item.category === "zone") {
      const plId = ids.make("pl");
      const poly = toPolygon(item.coords);
      zones.push({ id: plId, label: item.label, poly });
      push("fl_monitoring.polygon", plId, {
        id: plId,
        tags: "[]",
        coord: poly,
        label: item.label,
        notes: item.label,
        coords: JSON.stringify(poly),
        category: "zone",
      });
    } else if (
      item.category === "flow_meter" ||
      item.category === "pressure_sensor"
    ) {
      const pId = ids.make("p");
      const coord = toCoord(item.coords);
      points.push({
        id: pId,
        label: item.label,
        coord,
        category: item.category,
      });
      push("fl_monitoring.point", pId, {
        id: pId,
        tags: "[]",
        coord,
        label: item.label,
        notes: item.label,
        category: item.category,
      });
    }
  }

  // 2) links: flow_meter_in_zone by geometry
  let linkSeq = 1;
  for (const fm of points.filter((p) => p.category === "flow_meter")) {
    const z = zones.find((zz) => pointInPolygon(fm.coord, zz.poly));
    if (z) {
      const pk = linkSeq++;
      push("fl_monitoring.link", pk, {
        id: pk,
        args: { role: ["inlet"], order: null },
        notes: "",
        target_id1: fm.id,
        target_id2: z.id,
        relation_type: "flow_meter_in_zone",
      });
    }
  }

  // 3) starter metrics
  function addMetric(fields: any): string {
    const mId = ids.make("m");
    const merged = { ...DEFAULT_FIELDS, ...fields, id: mId };
    push("fl_monitoring.metricdefinition", mId, merged);
    return mId;
  }

  // per zone: Demand (QH), AZP (QH)
  const demandByZone = new Map<string, string>();
  const azpByZone = new Map<string, string>();
  for (const z of zones) {
    const demandId = addMetric({
      unit: "m³/h",
      label: `Zone Demand – ${z.label}`,
      category: "zone_demand",
      interval: "QUARTER_HOUR",
      describes: "QUARTER_HOUR",
      tags_list: ["sum_aggregated"],
      target_id: z.id,
    });
    demandByZone.set(z.id, demandId);

    const azpId = addMetric({
      unit: "m",
      label: `AZP – ${z.label}`,
      category: "average_zone_pressure",
      interval: "QUARTER_HOUR",
      describes: "QUARTER_HOUR",
      tags_list: ["avg_aggregated"],
      target_id: z.id,
    });
    azpByZone.set(z.id, azpId);
  }

  // per flow meter: reading + volume + delta trigger
  const fmVolumePerZone = new Map<string, string[]>();
  for (const fm of points.filter((p) => p.category === "flow_meter")) {
    const z = zones.find((zz) => pointInPolygon(fm.coord, zz.poly));
    if (z && !fmVolumePerZone.has(z.id)) fmVolumePerZone.set(z.id, []);

    const readingMetricId = addMetric({
      unit: "m³",
      label: `Flow Reading – ${fm.label}`,
      source: "USER",
      category: "flow_reading",
      interval: "QUARTER_HOUR",
      describes: "QUARTER_HOUR",
      tags_list: ["raw_data"],
      target_id: fm.id,
    });

    const volumeMetricId = addMetric({
      unit: "m³",
      label: `Flow Volume – ${fm.label}`,
      category: "flow_volume",
      interval: "QUARTER_HOUR",
      describes: "QUARTER_HOUR",
      tags_list: ["sum_aggregated"],
      target_id: fm.id,
    });

    if (z) fmVolumePerZone.get(z.id)!.push(volumeMetricId);

    const tId = ids.make("t");
    push("fl_dispatcher.metrictrigger", tId, {
      id: tId,
      caller: "REAL_TIME",
      is_active: true,
      calculator: "",
      calculators: [
        {
          calc_args: {
            inputs: {},
            metric_id: ids.guid(),
            time_range_type: "operation",
          },
          calc_name: "CALCULATE_DELTA",
        },
      ],
      description: `Compute Flow Volume – ${fm.label}`,
      schedule_job: "",
      input_metrics: [readingMetricId],
      output_metric: volumeMetricId,
    });
  }

  // per pressure sensor: pressure metric
  for (const ps of points.filter((p) => p.category === "pressure_sensor")) {
    addMetric({
      unit: "m",
      label: `Pressure – ${ps.label}`,
      category: "pressure",
      interval: "QUARTER_HOUR",
      describes: "QUARTER_HOUR",
      tags_list: ["raw_data"],
      target_id: ps.id,
    });
  }

  // 4) starter triggers per zone
  // Demand (sum from all flow volumes)
  for (const z of zones) {
    const demandOut = demandByZone.get(z.id)!;
    const volumeInputs = fmVolumePerZone.get(z.id) ?? [];
    if (volumeInputs.length) {
      const tId = ids.make("t");
      push("fl_dispatcher.metrictrigger", tId, {
        id: tId,
        caller: "REAL_TIME",
        is_active: true,
        calculator: "",
        calculators: [
          {
            calc_args: {
              inputs: {},
              metric_id: ids.guid(),
              time_range_type: "operation",
            },
            calc_name: "CALCULATE_ZONE_DEMAND",
          },
        ],
        description: `Zone Demand – ${z.label}`,
        schedule_job: "",
        input_metrics: volumeInputs,
        output_metric: demandOut,
      });
    }
  }

  // AZP (avg of all pressure metrics in the zone)
  const pressureMetricDefs = out.filter(
    (x) =>
      x.model === "fl_monitoring.metricdefinition" &&
      x.fields?.category === "pressure"
  );

  for (const z of zones) {
    const inZonePressureIds: string[] = [];
    for (const pm of pressureMetricDefs) {
      const ptId: string | undefined = pm.fields?.target_id;
      const pt = points.find((p) => p.id === ptId);
      if (pt && pointInPolygon(pt.coord, z.poly))
        inZonePressureIds.push(pm.pk as string);
    }
    if (inZonePressureIds.length) {
      const azpOut = azpByZone.get(z.id)!;
      const tId = ids.make("t");
      push("fl_dispatcher.metrictrigger", tId, {
        id: tId,
        caller: "REAL_TIME",
        is_active: true,
        calculator: "",
        calculators: [
          {
            calc_args: {
              inputs: {},
              metric_id: ids.guid(),
              time_range_type: "operation",
              aggregation_groups: [],
            },
            calc_name: "CALCULATE_AVG",
          },
        ],
        description: `AZP – ${z.label}`,
        schedule_job: "",
        input_metrics: inZonePressureIds,
        output_metric: azpOut,
      });
    }
  }

  return out;
}
