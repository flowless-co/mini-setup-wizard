/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FixtureItem, Coord, Polygon } from "../types";
import { IdRegistry } from "./ids";
import { pointInPolygon } from "./geo";

/** ---------------- helpers ---------------- */
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

const INTERVAL_MAP: Record<string, string> = {
  qh: "QUARTER_HOUR",
  hourly: "HOURLY",
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
};

const CATEGORY_ALIAS: Record<string, string> = {
  azp: "average_zone_pressure",
};

function normalizeCategory(cat: string): string {
  return CATEGORY_ALIAS[cat] ?? cat;
}
function normalizeInterval(k: string): string {
  return INTERVAL_MAP[k] ?? k;
}
function isDescriptor(x: unknown): x is string {
  return typeof x === "string" && x.startsWith("MetricCategory.");
}
function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}
// "MetricCategory.Zone.zone_demand.qh"
function parseDescriptor(
  desc: string
): { target: string; category: string; interval: string } | null {
  if (!isDescriptor(desc)) return null;
  const parts = desc.split(".");
  if (parts.length < 4) return null;
  const target = parts[1];
  const category = normalizeCategory(parts[2]);
  const interval = normalizeInterval(parts[3]);
  return { target, category, interval };
}

type ZoneCtx = {
  kind: "zone";
  zoneId: string;
  zoneLabel: string;
  zonePoly: Polygon;
};
type PtCtx = {
  kind: "point";
  pointId: string;
  pointLabel: string;
  pointCategory: string;
};

function replaceAllSafe(s: string, search: string, replace: string): string {
  return s.split(search).join(replace);
}
function applyStringPlaceholders(value: string, ctx: ZoneCtx | PtCtx): string {
  let out = value;
  if ((ctx as ZoneCtx).zoneId) {
    out = replaceAllSafe(out, "[[zone_id]]", (ctx as ZoneCtx).zoneId);
    out = replaceAllSafe(
      out,
      "[[zone_label]]",
      (ctx as ZoneCtx).zoneLabel ?? ""
    );
  }
  if ((ctx as PtCtx).pointId) {
    out = replaceAllSafe(out, "[[point_id]]", (ctx as PtCtx).pointId);
    out = replaceAllSafe(
      out,
      "[[point_label]]",
      (ctx as PtCtx).pointLabel ?? ""
    );
  }
  return out;
}
function isPointCategory(cat: string): boolean {
  return ["pressure", "flow_volume", "flow_reading"].includes(cat);
}

// tuple coercers — fixes TS2345 on polygons/coords
function toCoord(v: any): Coord {
  return [Number(v?.[0]), Number(v?.[1])] as Coord;
}
function toPolygon(poly: any): Polygon {
  return (poly ?? []).map((ring: any) =>
    (ring ?? []).map((c: any) => toCoord(c))
  ) as Polygon;
}
function centroid(poly: Polygon): Coord {
  const ring = poly?.[0] ?? [];
  if (!ring.length) return [0, 0];
  let sx = 0,
    sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  return [sx / ring.length, sy / ring.length] as Coord;
}

/** ---------------- main ---------------- */
export function applyHighLevel(
  low: FixtureItem[],
  template: any[] = []
): FixtureItem[] {
  const out: FixtureItem[] = [];
  const ids = new IdRegistry();

  // zones / points (strongly typed)
  const zones = low
    .filter((x) => x.model === "fl_monitoring.polygon")
    .map((x) => {
      const rawCoord =
        x.fields?.coord ??
        (x.fields?.coords ? JSON.parse(x.fields.coords) : undefined);
      return {
        id: String(x.pk),
        label: x.fields?.label as string,
        poly: toPolygon(rawCoord),
      };
    });

  const points = low
    .filter((x) => x.model === "fl_monitoring.point")
    .map((x) => ({
      id: String(x.pk),
      label: x.fields?.label as string,
      category: x.fields?.category as string,
      coord: toCoord(x.fields?.coord),
    }));

  const pointById = new Map(points.map((p) => [p.id, p]));
  const metrics = low.filter(
    (x) => x.model === "fl_monitoring.metricdefinition"
  );

  // category|interval|target_id -> metric pk
  const metricByKey = new Map<string, string>();
  for (const m of metrics) {
    const f = m.fields ?? {};
    const key = `${f.category}|${f.interval}|${f.target_id}`;
    metricByKey.set(key, String(m.pk));
  }

  // track existing triggers by output metric (avoid duplicates; allow overrides)
  const triggersByOutput = new Map<string, string | number>();
  for (const t of low.filter(
    (x) => x.model === "fl_dispatcher.metrictrigger"
  )) {
    const outId = t.fields?.output_metric;
    if (outId) triggersByOutput.set(String(outId), t.pk as string | number);
  }

  // abstraction_id -> created pk (bound to context)
  const createdByAbs = new Map<string, string | number>();
  const ctxKey = (ctx: ZoneCtx | PtCtx) =>
    ctx.kind === "zone" ? `zone:${ctx.zoneId}` : `pt:${ctx.pointId}`;
  const setAbs = (
    abs: string | undefined,
    ctx: ZoneCtx | PtCtx,
    pk: string | number
  ) => {
    if (!abs) return;
    createdByAbs.set(`${abs}::${ctxKey(ctx)}`, pk);
  };
  const getAbs = (
    abs: string | undefined,
    ctx: ZoneCtx | PtCtx
  ): string | number | undefined => {
    if (!abs) return undefined;
    return createdByAbs.get(`${abs}::${ctxKey(ctx)}`);
  };

  // de-duplicated metric creation
  function createMetric(fields: any): string {
    const f = { ...DEFAULT_FIELDS, ...fields };
    if (f.category) f.category = normalizeCategory(f.category);
    if (f.interval) f.interval = normalizeInterval(f.interval);
    const key = `${f.category}|${f.interval}|${f.target_id}`;
    const existing = metricByKey.get(key);
    if (existing) return existing;

    const mId = ids.make("m");
    const finalFields = { ...f, id: mId };
    out.push({
      model: "fl_monitoring.metricdefinition",
      pk: mId,
      fields: finalFields,
    });
    metricByKey.set(key, mId);
    return mId;
  }

  // resolve token -> metric ids (supports zone-expansion for point categories)
  function resolveTokenToMetricIds(
    token: string,
    ctx: ZoneCtx | PtCtx
  ): string[] {
    const ret: string[] = [];
    if (!token) return ret;

    // abstraction references support (non-descriptor)
    if (!isDescriptor(token)) {
      const viaAbs = getAbs(token, ctx);
      if (viaAbs) ret.push(String(viaAbs));
      return ret;
    }

    const p = parseDescriptor(token);
    if (!p) return ret;

    const { target, category, interval } = p;

    if (target.toLowerCase() === "zone") {
      if (ctx.kind !== "zone") return ret;
      const key = `${category}|${interval}|${ctx.zoneId}`;
      const mid = metricByKey.get(key);
      if (mid) ret.push(mid);
      return ret;
    }

    // point-level expansion inside zone
    if (
      ["pressure", "flowmeter"].includes(target.toLowerCase()) ||
      isPointCategory(category)
    ) {
      if (ctx.kind === "point") {
        const key = `${category}|${interval}|${ctx.pointId}`;
        const mid = metricByKey.get(key);
        if (mid) ret.push(mid);
        return ret;
      }
      const zPoly = (ctx as ZoneCtx).zonePoly;
      const requiredPointCat =
        category === "pressure"
          ? "pressure_sensor"
          : category.startsWith("flow_")
          ? "flow_meter"
          : undefined;

      for (const m of metrics) {
        const f = m.fields ?? {};
        if (f.category !== category || f.interval !== interval) continue;
        const pt = pointById.get(String(f.target_id));
        if (!pt) continue;
        if (requiredPointCat && pt.category !== requiredPointCat) continue;
        if (!pointInPolygon(pt.coord, zPoly)) continue;
        ret.push(String(m.pk));
      }
      return ret;
    }

    return ret;
  }

  // choose iteration granularity
  function iterationKindFor(item: any): "zone" | "point" {
    if (
      typeof item.output_metric === "string" &&
      isDescriptor(item.output_metric)
    ) {
      const outD = parseDescriptor(item.output_metric);
      if (outD) {
        if (outD.target.toLowerCase() === "zone") return "zone";
        if (
          ["pressure", "flowmeter"].includes(outD.target.toLowerCase()) ||
          isPointCategory(outD.category)
        ) {
          return "point";
        }
      }
    }
    const text = JSON.stringify(item);
    const strMatches = text.match(/"([^"\\]|\\.)*"/g) ?? [];
    const tokens = strMatches.map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return "";
      }
    });
    const descs = tokens.filter(isDescriptor) as string[];
    for (const d of descs) {
      const p = parseDescriptor(d);
      if (!p) continue;
      if (
        isPointCategory(p.category) ||
        ["pressure", "flowmeter"].includes(p.target.toLowerCase())
      ) {
        return "point";
      }
    }
    return "zone";
  }

  /** -------- deep resolver so high-level applies everywhere -------- */
  const METRIC_ARRAY_KEYS = new Set([
    "metrics",
    "metric_ids",
    "metric_descriptors",
  ]);
  function deepResolve(
    obj: any,
    ctx: ZoneCtx | PtCtx,
    path: string[] = []
  ): any {
    if (obj == null) return obj;

    const last = path[path.length - 1] || "";
    const inMetricArrayContext = METRIC_ARRAY_KEYS.has(last);

    if (typeof obj === "string") {
      const s = applyStringPlaceholders(obj, ctx);

      // contextual [FILL]
      if (s === "[FILL]") {
        if (last === "center" && ctx.kind === "zone")
          return centroid((ctx as ZoneCtx).zonePoly);
        if (last === "metric_id") return ids.guid();
        return ctx.kind === "zone"
          ? (ctx as ZoneCtx).zoneId
          : (ctx as PtCtx).pointId;
      }

      // descriptors
      if (isDescriptor(s)) {
        const mids = resolveTokenToMetricIds(s, ctx);
        if (inMetricArrayContext) return mids;
        if (last === "output_metric") return mids[0] ?? "";
        return mids[0] ?? s;
      }

      // abstraction IDs inside strings (allow)
      const maybeAbs = getAbs(s, ctx);
      if (maybeAbs) {
        if (inMetricArrayContext) return [String(maybeAbs)];
        if (last === "output_metric") return String(maybeAbs);
        return String(maybeAbs);
      }

      return s;
    }

    if (Array.isArray(obj)) {
      const mapped = obj.map((v) => deepResolve(v, ctx, path));
      if (inMetricArrayContext) {
        const flat: any[] = [];
        for (const v of mapped)
          Array.isArray(v) ? flat.push(...v) : flat.push(v);
        return flat.filter((v) => typeof v === "string" && v.length > 0);
      }
      return mapped;
    }

    if (typeof obj === "object") {
      const outObj: Record<string, any> = {};
      for (const [k, v] of Object.entries(obj)) {
        outObj[k] = deepResolve(v, ctx, [...path, k]);
      }
      if (Array.isArray(outObj.metric_descriptors)) {
        outObj.metric_ids = outObj.metric_descriptors;
        delete outObj.metric_descriptors;
      }
      if (outObj.center === "[FILL]" && ctx.kind === "zone") {
        outObj.center = centroid((ctx as ZoneCtx).zonePoly);
      }
      return outObj;
    }

    return obj;
  }

  /** -------- instantiation -------- */
  function instantiateItem(raw: any, ctx: ZoneCtx | PtCtx): void {
    // normalize shorthand
    if (raw.model === "metrictrigger")
      raw.model = "fl_dispatcher.metrictrigger";

    // METRIC
    if (raw.model === "fl_monitoring.metricdefinition") {
      const fields = deepResolve(raw.fields ?? {}, ctx);
      const mId = createMetric(fields);
      setAbs(raw.abstraction_id, ctx, mId);
      return;
    }

    // TRIGGER (UPDATE if output already has a trigger; else CREATE)
    if (raw.model === "fl_dispatcher.metrictrigger") {
      const resolved = deepResolve(deepClone(raw), ctx);

      // ensure calculators & inputs are well-formed
      const calculators = (resolved.calculators ?? []).map((c: any) => {
        const args = (c.calc_args = c.calc_args ?? {});
        args.metric_id = args.metric_id || ids.guid();
        args.time_range_type = args.time_range_type || "operation";
        const inp = (args.inputs = args.inputs ?? {});
        if (!Array.isArray(inp.metrics)) inp.metrics = [];
        return c;
      });

      const inputMetrics = Array.from(
        new Set(
          (calculators ?? [])
            .flatMap((c: any) => c?.calc_args?.inputs?.metrics ?? [])
            .filter((m: any) => typeof m === "string" && m.length > 0)
        )
      );

      const outputMetric: string = resolved.output_metric || "";
      if (!outputMetric) {
        setAbs(raw.abstraction_id, ctx, "");
        return;
      }

      // UPDATE existing trigger with same output metric (override)
      if (triggersByOutput.has(outputMetric)) {
        const existingPk = String(triggersByOutput.get(outputMetric)!);
        out.push({
          model: "fl_dispatcher.metrictrigger",
          pk: existingPk,
          fields: {
            id: existingPk,
            caller: "REAL_TIME",
            is_active: true,
            calculator: "",
            calculators,
            description: resolved.description ?? "",
            schedule_job: resolved.schedule_job ?? "",
            input_metrics: inputMetrics,
            output_metric: outputMetric,
          },
        });
        setAbs(raw.abstraction_id, ctx, existingPk);
        return;
      }

      // CREATE new trigger otherwise
      const tId = ids.make("t");
      out.push({
        model: "fl_dispatcher.metrictrigger",
        pk: tId,
        fields: {
          id: tId,
          caller: "REAL_TIME",
          is_active: true,
          calculator: "",
          calculators,
          description: resolved.description ?? "",
          schedule_job: resolved.schedule_job ?? "",
          input_metrics: inputMetrics,
          output_metric: outputMetric,
        },
      });
      triggersByOutput.set(outputMetric, tId);
      setAbs(raw.abstraction_id, ctx, tId);
      return;
    }

    // CHART
    if (raw.model === "fl_page_settings.chart") {
      const pk = ids.makeInt();
      const fields = deepResolve(raw.fields ?? {}, ctx);
      const args = (fields.args = fields.args ?? {});
      const idsArr: string[] = Array.isArray(args.metric_ids)
        ? args.metric_ids
        : [];
      (fields as any).metrics = idsArr;
      out.push({
        model: "fl_page_settings.chart",
        pk,
        fields: { id: pk, ...fields },
      });
      setAbs(raw.abstraction_id, ctx, pk);
      return;
    }

    // CARD
    if (raw.model === "fl_page_settings.card") {
      const pk = ids.makeInt();
      console.log(raw.fields);
      const fields = deepResolve(raw.fields ?? {}, ctx);
      const args = (fields.args = fields.args ?? {});
      if (
        Array.isArray((args as any).metric_descriptors) &&
        !Array.isArray(args.metric_ids)
      ) {
        args.metric_ids = (args as any).metric_descriptors;
        delete (args as any).metric_descriptors;
      }
      out.push({
        model: "fl_page_settings.card",
        pk,
        fields: { id: pk, ...fields },
      });
      setAbs(raw.abstraction_id, ctx, pk);
      return;
    }

    // PAGE SETTINGS
    if (raw.model === "fl_page_settings.pagesettings") {
      const pk = ids.makeInt();
      const fields = deepResolve(raw.fields ?? {}, ctx);

      const charts = (fields.charts ?? []).map((ref: any) => {
        const viaAbs = getAbs(String(ref), ctx);
        return viaAbs ?? ref;
      });
      const cards = (fields.cards ?? []).map((ref: any) => {
        const viaAbs = getAbs(String(ref), ctx);
        return viaAbs ?? ref;
      });

      out.push({
        model: "fl_page_settings.pagesettings",
        pk,
        fields: { id: pk, ...fields, charts, cards },
      });
      setAbs(raw.abstraction_id, ctx, pk);
      return;
    }

    // any other model (maps, etc.)
    {
      const pk = ids.makeInt();
      const fields = deepResolve(raw.fields ?? {}, ctx);
      out.push({ model: raw.model, pk, fields: { id: pk, ...fields } });
      setAbs(raw.abstraction_id, ctx, pk);
    }
  }

  if (!template || !Array.isArray(template) || template.length === 0)
    return out;

  for (const raw of template) {
    const kind = iterationKindFor(raw);
    if (kind === "zone") {
      for (const z of zones) {
        instantiateItem(raw, {
          kind: "zone",
          zoneId: z.id,
          zoneLabel: z.label,
          zonePoly: z.poly,
        });
      }
    } else {
      for (const p of points) {
        instantiateItem(raw, {
          kind: "point",
          pointId: p.id,
          pointLabel: p.label,
          pointCategory: p.category,
        });
      }
    }
  }

  return out;
}
