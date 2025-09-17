/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FixtureItem, Coord, Polygon } from "../types";
import { IdRegistry } from "./ids";
import { pointInPolygon } from "./geo";

/* ============================== Types ============================== */

type HLAbstraction = {
  abstraction_id?: string | number;
  model?: string;
  fields?: any;
  args?: any;
  dependencies?: { cards_ids?: string[] } | any;
  output_metric?: string;
  calculators?: Array<{
    calc_name?: string;
    calc_args?: {
      inputs?: { metrics?: string[] };
      [k: string]: any;
    };
  }>;
  [k: string]: any;
};

type ParsedDesc = { target: string; category: string; interval: string };

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

type MetricKey = string; // `${category}|${interval}|${target_id}`

type ZoneReg = {
  /** canonical ctx id (PK as string) */
  pk: string;
  /** optional external domain id if present in fields.id */
  extId?: string;
  /** union of all ids that should be considered valid for this polygon */
  allIds: string[];
  label: string;
  poly: Polygon;
};

type PointReg = { id: string; label: string; coord: Coord; category: string };

type Registry = {
  metricByKey: Map<MetricKey, string>;
  triggerByOutput: Map<string, string | number>;
  createdByAbs: Map<string, string | number>;
  zones: ZoneReg[];
  points: PointReg[];
  pointById: Map<string, PointReg>;
};

/* ============================== Constants ============================== */

const MODEL = {
  POLYGON: "fl_monitoring.polygon",
  POINT: "fl_monitoring.point",
  METRIC: "fl_monitoring.metricdefinition",
  TRIGGER: "fl_dispatcher.metrictrigger",
  PAGE: "fl_page_settings.pagesettings",
  CHART: "fl_page_settings.chart",
  CARD: "fl_page_settings.card",
  MAP: "fl_page_settings.map",
} as const;

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

// deepResolve resolves only these arrays; metric_descriptors stay for union later
const METRIC_ARRAY_KEYS = new Set(["metrics", "metric_ids"]);
const arrayify = <T>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

/* ============================== Utils ============================== */

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
function replaceAllSafe(s: string, search: string, replace: string): string {
  return s.split(search).join(replace);
}
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
function ctxKey(ctx: ZoneCtx | PtCtx): string {
  return ctx.kind === "zone" ? `zone:${ctx.zoneId}` : `pt:${ctx.pointId}`;
}
function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/* ============================== Parsing ============================== */

function parseDescriptor(desc: string): ParsedDesc | null {
  if (!isDescriptor(desc)) return null;
  const parts = desc.split(".");
  if (parts.length < 4) return null;
  const target = parts[1];
  const category = normalizeCategory(parts[2]);
  const interval = normalizeInterval(parts[3]);
  return { target, category, interval };
}
function matchMetricAbsToDescriptor(metricAbs: any, desc: ParsedDesc): boolean {
  const f = metricAbs?.fields ?? {};
  const cat = normalizeCategory(f.category ?? "");
  const intv = normalizeInterval(f.interval ?? "");
  if (!cat || !intv) return false;
  return cat === desc.category && intv === desc.interval;
}

/* ============================== Registry ============================== */

function expandIdForms(id: string): string[] {
  const out = new Set<string>([id]);
  const n = Number(id);
  if (Number.isFinite(n)) out.add(String(n)); // normalize numerics
  return Array.from(out);
}

function buildRegistry(low: FixtureItem[]): Registry {
  const zones: ZoneReg[] = low
    .filter((x) => x.model === MODEL.POLYGON)
    .map((x) => {
      const rawCoord =
        x.fields?.coord ??
        (x.fields?.coords ? JSON.parse(x.fields.coords) : undefined);
      const pk = String(x.pk);
      const extMaybe = x.fields?.id;
      const extId = extMaybe != null ? String(extMaybe) : undefined;
      const allIds = uniq(
        [pk, ...(extId ? [extId] : [])].flatMap(expandIdForms)
      );
      return {
        pk,
        extId,
        allIds,
        label: x.fields?.label,
        poly: toPolygon(rawCoord),
      };
    });

  const points: PointReg[] = low
    .filter((x) => x.model === MODEL.POINT)
    .map((x) => ({
      id: String(x.pk),
      label: x.fields?.label,
      category: x.fields?.category,
      coord: toCoord(x.fields?.coord),
    }));

  const metricByKey = new Map<MetricKey, string>();
  for (const m of low.filter((x) => x.model === MODEL.METRIC)) {
    const f = m.fields ?? {};
    metricByKey.set(`${f.category}|${f.interval}|${f.target_id}`, String(m.pk));
  }

  const triggerByOutput = new Map<string, string | number>();
  for (const t of low.filter((x) => x.model === MODEL.TRIGGER)) {
    const om = t.fields?.output_metric;
    if (om) triggerByOutput.set(String(om), t.pk as string | number);
  }

  return {
    metricByKey,
    triggerByOutput,
    createdByAbs: new Map(),
    zones,
    points,
    pointById: new Map(points.map((p) => [p.id, p])),
  };
}
function setAbs(
  reg: Registry,
  abs: string | number | undefined,
  ctx: ZoneCtx | PtCtx,
  pk: string | number
): void {
  if (abs == null) return;
  reg.createdByAbs.set(`${abs}::${ctxKey(ctx)}`, pk);
}
function getAbs(
  reg: Registry,
  abs: string | number | undefined,
  ctx: ZoneCtx | PtCtx
): string | number | undefined {
  if (abs == null) return undefined;
  return reg.createdByAbs.get(`${abs}::${ctxKey(ctx)}`);
}
function getAllAbsInstancePks(
  reg: Registry,
  absId: string | number
): Array<string | number> {
  const prefix = `${String(absId)}::`;
  const pks: Array<string | number> = [];
  for (const [k, v] of reg.createdByAbs.entries())
    if (k.startsWith(prefix)) pks.push(v);
  return pks;
}

/* ============================== Filtering (graph slice) ============================== */

function pickPageCode(item: any): string | null {
  const fields = item?.fields ?? {};
  const sectionObj =
    fields.section ?? fields.args?.section ?? item?.args?.section ?? null;
  if (sectionObj && typeof sectionObj === "object" && sectionObj.code)
    return String(sectionObj.code);
  const pageObj = fields.page ?? fields.args?.page ?? item?.args?.page ?? null;
  if (!pageObj) return null;
  if (typeof pageObj === "string") return pageObj;
  if (pageObj?.code) return String(pageObj.code);
  return null;
}
function collectStringsDeep(node: any, out: Set<string>) {
  if (node == null) return;
  if (typeof node === "string") {
    out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((x) => collectStringsDeep(x, out));
    return;
  }
  if (typeof node === "object")
    for (const v of Object.values(node)) collectStringsDeep(v, out);
}
function collectDescriptorsDeep(node: any, acc: Set<string>) {
  const strings = new Set<string>();
  collectStringsDeep(node, strings);
  for (const s of strings) if (isDescriptor(s)) acc.add(s);
}
function extractPageRefs(page: any): {
  chartAbs: Set<string>;
  cardAbs: Set<string>;
  mapAbs: Set<string>;
} {
  const charts = new Set<string>();
  const cards = new Set<string>();
  const maps = new Set<string>();
  const f = page?.fields ?? {};

  for (const id of arrayify<string>(f.charts))
    if (typeof id === "string") charts.add(id);
  for (const id of arrayify<string>(f.cards))
    if (typeof id === "string") cards.add(id);
  for (const id of arrayify<string>(f.maps))
    if (typeof id === "string") maps.add(id);

  const sidepane = f.args?.sidepane?.by_target_category ?? [];
  for (const blk of arrayify<any>(sidepane)) {
    for (const id of arrayify<string>(blk?.charts))
      if (typeof id === "string") charts.add(id);
    for (const id of arrayify<string>(blk?.cards))
      if (typeof id === "string") cards.add(id);
  }

  const deps = page?.dependencies ?? {};
  for (const id of arrayify<string>(deps.cards_ids))
    if (typeof id === "string") cards.add(id);

  return { chartAbs: charts, cardAbs: cards, mapAbs: maps };
}

export function filter_abstract(
  selected_pages: string[],
  abstractions: HLAbstraction[]
): HLAbstraction[] {
  const abs = Array.isArray(abstractions) ? abstractions.slice() : [];
  if (!abs.length) return [];
  const wantedPageCodes = new Set((selected_pages ?? []).map(String));
  if (!wantedPageCodes.size) return [];

  const keptPages: HLAbstraction[] = [];
  for (const a of abs) {
    if ((a as any).model !== MODEL.PAGE) continue;
    const code = pickPageCode(a);
    if (!code) continue;
    if (wantedPageCodes.has(code)) keptPages.push(a);
  }

  const wantedChartIds = new Set<string>();
  const wantedCardIds = new Set<string>();
  const wantedMapIds = new Set<string>();
  for (const p of keptPages) {
    const { chartAbs, cardAbs, mapAbs } = extractPageRefs(p);
    chartAbs.forEach((x) => wantedChartIds.add(x));
    cardAbs.forEach((x) => wantedCardIds.add(x));
    mapAbs.forEach((x) => wantedMapIds.add(x));
  }

  const keptCharts: HLAbstraction[] = [];
  const keptCards: HLAbstraction[] = [];
  const keptMaps: HLAbstraction[] = [];
  for (const a of abs) {
    if (
      a.model === MODEL.CHART &&
      a?.abstraction_id &&
      wantedChartIds.has(String(a.abstraction_id))
    )
      keptCharts.push(a);
    if (
      a.model === MODEL.CARD &&
      a?.abstraction_id &&
      wantedCardIds.has(String(a.abstraction_id))
    )
      keptCards.push(a);
    if (
      a.model === MODEL.MAP &&
      a?.abstraction_id &&
      wantedMapIds.has(String(a.abstraction_id))
    )
      keptMaps.push(a);
  }

  const initialDesc = new Set<string>();
  for (const c of keptCharts) collectDescriptorsDeep(c, initialDesc);
  for (const c of keptCards) collectDescriptorsDeep(c, initialDesc);
  for (const m of keptMaps) collectDescriptorsDeep(m, initialDesc);

  type TrigIdx = {
    item: HLAbstraction;
    outDesc: ParsedDesc;
    inDescs: ParsedDesc[];
  };
  const triggerIndex: TrigIdx[] = [];
  for (const t of abs) {
    const model = t.model;
    if (model !== MODEL.TRIGGER && model !== "metrictrigger") continue;
    const outStr: string | undefined = (t as any).output_metric;
    const out = outStr && isDescriptor(outStr) ? parseDescriptor(outStr) : null;
    if (!out) continue;

    const inSet = new Set<string>();
    const calcs = arrayify<any>((t as any).calculators);
    for (const calc of calcs) {
      const inputs = calc?.calc_args?.inputs?.metrics ?? [];
      for (const s of arrayify<string>(inputs))
        if (isDescriptor(s)) inSet.add(s);
    }
    const inDescs = Array.from(inSet)
      .map((s) => parseDescriptor(s)!)
      .filter(Boolean) as ParsedDesc[];

    triggerIndex.push({ item: t, outDesc: out, inDescs });
  }

  const descSet = new Set<string>(initialDesc);
  const keptTriggersSet = new Set<HLAbstraction>();

  const outMatches = (a: ParsedDesc, b: ParsedDesc) =>
    a.category === b.category &&
    a.interval === b.interval &&
    a.target === b.target;

  let advanced = true;
  while (advanced) {
    advanced = false;
    const current = Array.from(descSet)
      .map((s) => parseDescriptor(s)!)
      .filter(Boolean) as ParsedDesc[];

    for (const cur of current) {
      for (const ti of triggerIndex) {
        if (!outMatches(ti.outDesc, cur)) continue;
        if (!keptTriggersSet.has(ti.item)) {
          keptTriggersSet.add(ti.item);
          advanced = true;
        }
        for (const d of ti.inDescs) {
          const token = `MetricCategory.${d.target}.${d.category}.${d.interval}`;
          if (!descSet.has(token)) {
            descSet.add(token);
            advanced = true;
          }
        }
      }
    }
  }

  const parsedClosure = Array.from(descSet)
    .map((s) => parseDescriptor(s)!)
    .filter(Boolean) as ParsedDesc[];

  const keptMetricAbs: HLAbstraction[] = [];
  for (const a of abs) {
    if (a.model !== MODEL.METRIC) continue;
    if (parsedClosure.some((d) => matchMetricAbsToDescriptor(a, d)))
      keptMetricAbs.push(a);
  }

  const closureTokens = new Set<string>(descSet);
  const keptTriggers: HLAbstraction[] = [];
  for (const t of keptTriggersSet) {
    const outStr: string = (t as any).output_metric;
    if (!isDescriptor(outStr) || !closureTokens.has(outStr)) continue;

    const calcs = arrayify<any>((t as any).calculators);
    let ok = true;
    for (const calc of calcs) {
      const inputs = arrayify<string>(calc?.calc_args?.inputs?.metrics);
      for (const s of inputs) {
        if (isDescriptor(s) && !closureTokens.has(s)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (ok) keptTriggers.push(t);
  }

  const keptSet = new Set<HLAbstraction>();
  keptPages.forEach((x) => keptSet.add(x));
  keptCharts.forEach((x) => keptSet.add(x));
  keptCards.forEach((x) => keptSet.add(x));
  keptMaps.forEach((x) => keptSet.add(x));
  keptMetricAbs.forEach((x) => keptSet.add(x));
  keptTriggers.forEach((x) => keptSet.add(x));

  return Array.from(keptSet);
}

/* ============================== Public API ============================== */

export function applyHighLevel(
  lowContent: FixtureItem[],
  abstractions: HLAbstraction[] = [],
  selectedPages: string[] = []
): FixtureItem[] {
  return init(lowContent, abstractions, selectedPages);
}

export function init(
  low_content: FixtureItem[],
  abstractions: HLAbstraction[],
  selected_pages: string[]
): FixtureItem[] {
  if (!selected_pages || selected_pages.length === 0) return [];

  const ids = new IdRegistry();
  const registry = buildRegistry(low_content);

  const abstract_network = filter_abstract(selected_pages, abstractions);

  const abstract_metrics = filter_metric_abstract(abstract_network);
  const targets = filter_targets(low_content);
  const metrics = create_metrics(abstract_metrics, targets, registry, ids);

  const abstract_triggers = filter_triggers(abstract_network);
  const low_metrics = get_low_metrics(low_content);
  const all_metrics = [...metrics, ...low_metrics];
  const triggers = create_triggers(
    all_metrics,
    abstract_triggers,
    targets,
    registry,
    ids
  );

  const content_setup: Record<string, FixtureItem[]> = {};
  content_setup["cards"] = create_cards(abstract_network, registry, ids);
  content_setup["charts"] = create_charts(abstract_network, registry, ids);
  content_setup["maps"] = create_maps(
    abstract_network,
    content_setup,
    registry,
    ids
  );
  const pages = create_pages(abstract_network, content_setup, registry, ids);

  return [
    ...metrics,
    ...triggers,
    ...content_setup.cards,
    ...content_setup.charts,
    ...content_setup.maps,
    ...pages,
  ];
}

/* ============================== Targets ============================== */

export function filter_targets(low_content: FixtureItem[]) {
  const polygons = low_content
    .filter((x) => x.model === MODEL.POLYGON)
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

  const points = low_content
    .filter((x) => x.model === MODEL.POINT)
    .map((x) => ({
      id: String(x.pk),
      label: x.fields?.label as string,
      category: x.fields?.category as string,
      coord: toCoord(x.fields?.coord),
    }));

  return { polygons, points };
}

/* ============================== Iteration Kinds & Ctx ============================== */

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
      )
        return "point";
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
    )
      return "point";
  }
  return "zone";
}
function toZoneCtxs(reg: Registry): ZoneCtx[] {
  // Keep ctx.zoneId as PK to stay consistent with low metrics target_id
  return reg.zones.map((z) => ({
    kind: "zone",
    zoneId: z.pk,
    zoneLabel: z.label,
    zonePoly: z.poly,
  }));
}
function toPointCtxs(reg: Registry): PtCtx[] {
  return reg.points.map((p) => ({
    kind: "point",
    pointId: p.id,
    pointLabel: p.label,
    pointCategory: p.category,
  }));
}

/* ============================== Resolution ============================== */

// Union of metric ids for a list of descriptors across *all* zone/point contexts.
function resolveDescriptorsAcrossAll(
  descriptors: string[],
  reg: Registry
): string[] {
  const mids = new Set<string>();
  const zoneCtxs = toZoneCtxs(reg);
  const pointCtxs = toPointCtxs(reg);

  for (const d of descriptors) {
    for (const z of zoneCtxs)
      for (const m of resolveTokenToMetricIds(d, z, reg)) mids.add(m);
    for (const p of pointCtxs)
      for (const m of resolveTokenToMetricIds(d, p, reg)) mids.add(m);
  }
  return Array.from(mids);
}

function applyPlaceholdersInString(s: string, ctx: ZoneCtx | PtCtx): string {
  return applyStringPlaceholders(s, ctx);
}

function deepResolve(
  obj: any,
  ctx: ZoneCtx | PtCtx,
  reg: Registry,
  ids: IdRegistry
): any {
  const walk = (node: any, path: string[]): any => {
    const last = path[path.length - 1] || "";
    const inMetricArray = METRIC_ARRAY_KEYS.has(last);

    if (typeof node === "string") {
      const s = applyPlaceholdersInString(node, ctx);

      if (s === "[FILL]") {
        if (last === "center" && ctx.kind === "zone")
          return centroid((ctx as ZoneCtx).zonePoly);
        if (last === "metric_id") return ids.guid();
        return ctx.kind === "zone"
          ? (ctx as ZoneCtx).zoneId
          : (ctx as PtCtx).pointId;
      }

      if (isDescriptor(s)) {
        // Keep descriptors inside "metric_descriptors" for union later.
        if (last === "metric_descriptors") return s;

        const mids = resolveTokenToMetricIds(s, ctx, reg);
        if (inMetricArray) return mids;
        if (last === "output_metric") return mids[0] ?? "";
        return mids[0] ?? s;
      }

      const viaAbs = getAbs(reg, s, ctx);
      if (viaAbs) {
        if (inMetricArray) return [String(viaAbs)];
        if (last === "output_metric") return String(viaAbs);
        return String(viaAbs);
      }

      return s;
    }

    if (Array.isArray(node)) {
      const mapped = node.map((v) => walk(v, path));
      if (inMetricArray) {
        const flat: any[] = [];
        for (const v of mapped)
          Array.isArray(v) ? flat.push(...v) : flat.push(v);
        return flat.filter((v) => typeof v === "string" && v.length > 0);
      }
      return mapped;
    }

    if (typeof node === "object" && node !== null) {
      const outObj: Record<string, any> = {};
      for (const [k, v] of Object.entries(node))
        outObj[k] = walk(v, [...path, k]);

      if (outObj.center === "[FILL]" && ctx.kind === "zone") {
        outObj.center = centroid((ctx as ZoneCtx).zonePoly);
      }
      return outObj;
    }

    return node;
  };
  return walk(obj, []);
}

/* ============================== Polygon binding repair ============================== */

function pickDefaultPolygonId(reg: Registry): string | null {
  if (!reg.zones.length) return null;
  // Prefer external id if available, else pk
  return reg.zones[0].extId ?? reg.zones[0].pk;
}
function centroidOfAllPolygons(reg: Registry): Coord | null {
  if (!reg.zones.length) return null;
  let sx = 0,
    sy = 0;
  for (const z of reg.zones) {
    const c = centroid(z.poly);
    sx += c[0];
    sy += c[1];
  }
  return [sx / reg.zones.length, sy / reg.zones.length] as Coord;
}

function buildValidPolygonIdSet(reg: Registry): Set<string> {
  const set = new Set<string>();
  for (const z of reg.zones) {
    for (const id of z.allIds) {
      set.add(id);
      // also add normalized numeric form (already included by expandIdForms)
    }
  }
  return set;
}

function idsAllNumeric(ids: string[]): boolean {
  if (!ids.length) return false;
  for (const s of ids) {
    const n = Number(s);
    if (!Number.isFinite(n) || String(n) !== s) return false;
  }
  return true;
}
function castIdLike(example: unknown, idStr: string): string | number {
  if (typeof example === "number") {
    const n = Number(idStr);
    if (Number.isFinite(n)) return n;
  }
  return idStr;
}
function maybeParseJSON(value: unknown): any | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Deeply sanitize any polygon/zone id(s) at any nesting level.
 * Accepts both PKs and external ids as valid; prefers external id for defaults.
 * Also fixes stringified JSON blobs.
 */
function ensurePolygonBindingsDeep(fields: any, reg: Registry): void {
  const validStrIds = reg.zones.flatMap((z) => z.allIds);
  const validSet = buildValidPolygonIdSet(reg);
  const defaultStr = pickDefaultPolygonId(reg) ?? undefined;

  const allNumeric = idsAllNumeric(validStrIds);
  const numericDefaults = reg.zones
    .map((z) => z.extId ?? z.pk)
    .filter((s) => Number.isFinite(Number(s)))
    .map((s) => Number(s));

  const isPolyishKey = (k: string) =>
    /\b(polygon|zone|geom|feature)\b/i.test(k) && /\bids?\b/i.test(k);

  const placeholderRE = /^\s*\[\[\s*(polygon|zone)_id\s*\]\]\s*$/i;

  const fixOne = (val: any, hintKey?: string): any => {
    const parsed = maybeParseJSON(val);
    if (parsed !== undefined) {
      sanitize(parsed);
      return JSON.stringify(parsed);
    }

    if (typeof val === "string") {
      const s = val.trim();
      if (placeholderRE.test(s)) return defaultStr ?? null;
      if (validSet.has(s)) return s;
      const n = Number(s);
      if (Number.isFinite(n) && validSet.has(String(n))) return String(n);
      return defaultStr ?? null;
    }
    if (typeof val === "number") {
      const s = String(val);
      if (validSet.has(s)) return val;
      // try external default cast
      if (defaultStr != null) return castIdLike(val, defaultStr);
      return null;
    }
    return val;
  };

  const sanitizeNode = (node: any, key?: string, parent?: any) => {
    if (node == null) return;

    const asObj = maybeParseJSON(node);
    if (asObj !== undefined) {
      sanitize(asObj);
      const replacement = JSON.stringify(asObj);
      if (parent && key != null) parent[key] = replacement;
      return;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (typeof child === "string" || typeof child === "number") {
          if (key && isPolyishKey(key)) {
            node[i] = fixOne(child, key);
          } else {
            if (
              child === "" ||
              placeholderRE.test(String(child)) ||
              validSet.has(String(child)) ||
              validSet.has(String(Number(child)))
            ) {
              node[i] = fixOne(child, key);
            }
          }
        } else {
          sanitizeNode(child, key, node);
        }
      }
      if (key && isPolyishKey(key)) {
        const cleaned = node.filter((x: any) => x != null && x !== "");
        if (cleaned.length === 0) {
          if (allNumeric && numericDefaults.length)
            (parent as any)[key] = numericDefaults.slice();
          else (parent as any)[key] = validStrIds.slice();
        } else {
          (parent as any)[key] = cleaned;
        }
      }
      return;
    }

    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string" || typeof v === "number") {
          if (isPolyishKey(k)) {
            const fixed = fixOne(v, k);
            if (fixed == null || fixed === "") {
              if (allNumeric && numericDefaults.length)
                (node as any)[k] = numericDefaults[0];
              else (node as any)[k] = defaultStr ?? null;
            } else {
              (node as any)[k] = fixed;
            }
          } else if (placeholderRE.test(String(v))) {
            (node as any)[k] = defaultStr ?? v;
          }
        } else {
          sanitizeNode(v, k, node);
        }
      }
      return;
    }
  };

  const sanitize = (root: any) => sanitizeNode(root);

  sanitize(fields);

  // If absolutely no polygon bindings exist anywhere, set args.polygon_ids to all
  const bindingsExist = (() => {
    let found = false;
    const scan = (n: any, k?: string) => {
      if (found || n == null) return;
      if (Array.isArray(n)) {
        if (k && isPolyishKey(k) && n.length) {
          if (
            n.some(
              (x) => validSet.has(String(x)) || validSet.has(String(Number(x)))
            )
          )
            found = true;
        }
        n.forEach((x) => scan(x, k));
        return;
      }
      if (typeof n === "object") {
        for (const [kk, vv] of Object.entries(n)) {
          if (isPolyishKey(kk)) {
            const arr = Array.isArray(vv) ? vv : [vv];
            if (
              arr.some(
                (x) =>
                  validSet.has(String(x)) || validSet.has(String(Number(x)))
              )
            ) {
              found = true;
              break;
            }
          }
          scan(vv, kk);
        }
        return;
      }
    };
    scan(fields);
    return found;
  })();

  if (!bindingsExist && reg.zones.length) {
    const args = (fields.args = fields.args ?? {});
    // strings are safest default; they include both pk and ext forms already
    args.polygon_ids = reg.zones.map((z) => z.extId ?? z.pk);
  }

  if (!fields.center) {
    const c = centroidOfAllPolygons(reg);
    if (c) fields.center = c;
  }
}

/* ============================== UI Creators (singletons) ============================== */

function create_cards(
  abstract_network: HLAbstraction[],
  reg: Registry,
  ids: IdRegistry
): FixtureItem[] {
  const out: FixtureItem[] = [];
  for (const raw of abstract_network) {
    if (raw.model !== MODEL.CARD) continue;

    const pk = ids.makeInt();
    const neutralCtx = {
      kind: "zone",
      zoneId: "",
      zoneLabel: "",
      zonePoly: [[]],
    } as unknown as ZoneCtx;
    const fields = deepResolve(raw.fields ?? {}, neutralCtx, reg, ids);

    const args = (fields.args = fields.args ?? {});
    const descriptors = arrayify<string>(args.metric_descriptors).filter(
      isDescriptor
    );
    if (descriptors.length) {
      const mids = resolveDescriptorsAcrossAll(descriptors, reg);
      args.metric_ids = mids;
      delete args.metric_descriptors;
    }

    out.push({ model: MODEL.CARD, pk, fields: { id: pk, ...fields } });
    setAbs(
      reg,
      raw.abstraction_id,
      {
        kind: "zone",
        zoneId: "__GLOBAL__",
        zoneLabel: "",
        zonePoly: [[]],
      } as any,
      pk
    );
  }
  return out;
}

function create_charts(
  abstract_network: HLAbstraction[],
  reg: Registry,
  ids: IdRegistry
): FixtureItem[] {
  const out: FixtureItem[] = [];
  for (const raw of abstract_network) {
    if (raw.model !== MODEL.CHART) continue;

    const pk = ids.makeInt();
    const neutralCtx = {
      kind: "zone",
      zoneId: "",
      zoneLabel: "",
      zonePoly: [[]],
    } as unknown as ZoneCtx;
    const fields = deepResolve(raw.fields ?? {}, neutralCtx, reg, ids);

    const args = (fields.args = fields.args ?? {});
    const descriptors = arrayify<string>(args.metric_descriptors).filter(
      isDescriptor
    );
    if (descriptors.length) {
      const mids = resolveDescriptorsAcrossAll(descriptors, reg);
      args.metric_ids = mids;
      delete args.metric_descriptors;
    }
    const idsArr: string[] = Array.isArray(args.metric_ids)
      ? args.metric_ids
      : [];
    (fields as any).metrics = idsArr;

    out.push({ model: MODEL.CHART, pk, fields: { id: pk, ...fields } });
    setAbs(
      reg,
      raw.abstraction_id,
      {
        kind: "zone",
        zoneId: "__GLOBAL__",
        zoneLabel: "",
        zonePoly: [[]],
      } as any,
      pk
    );
  }
  return out;
}

function create_maps(
  abstract_network: HLAbstraction[],
  _content_setup: Record<string, FixtureItem[]>,
  reg: Registry,
  ids: IdRegistry
): FixtureItem[] {
  const out: FixtureItem[] = [];
  for (const raw of abstract_network) {
    if (raw.model !== MODEL.MAP) continue;

    const pk = ids.makeInt();
    const neutralCtx = {
      kind: "zone",
      zoneId: "",
      zoneLabel: "",
      zonePoly: [[]],
    } as unknown as ZoneCtx;
    const fields = deepResolve(raw.fields ?? {}, neutralCtx, reg, ids);

    // Deep & type-safe polygon binding sanitizer; accepts PKs and fields.id
    ensurePolygonBindingsDeep(fields, reg);

    out.push({ model: MODEL.MAP, pk, fields: { id: pk, ...fields } });
    setAbs(
      reg,
      raw.abstraction_id,
      {
        kind: "zone",
        zoneId: "__GLOBAL__",
        zoneLabel: "",
        zonePoly: [[]],
      } as any,
      pk
    );
  }
  return out;
}

/* ---- Pages: create each page ONCE; reference singleton chart/card/map instances ---- */

function create_pages(
  abstract_network: HLAbstraction[],
  _content_setup: Record<string, FixtureItem[]>,
  reg: Registry,
  ids: IdRegistry
): FixtureItem[] {
  const out: FixtureItem[] = [];

  for (const raw of abstract_network) {
    if (raw.model !== MODEL.PAGE) continue;

    const pk = ids.makeInt();
    const neutralCtx = {
      kind: "zone",
      zoneId: "",
      zoneLabel: "",
      zonePoly: [[]],
    } as unknown as ZoneCtx;
    const fields = deepResolve(raw.fields ?? {}, neutralCtx, reg, ids);

    const charts = uniq(
      arrayify<any>(fields.charts).flatMap((ref) =>
        getAllAbsInstancePks(reg, String(ref))
      )
    );
    const cards = uniq(
      arrayify<any>(fields.cards).flatMap((ref) =>
        getAllAbsInstancePks(reg, String(ref))
      )
    );
    const maps = uniq(
      arrayify<any>(fields.maps).flatMap((ref) =>
        getAllAbsInstancePks(reg, String(ref))
      )
    );

    out.push({
      model: MODEL.PAGE,
      pk,
      fields: { id: pk, ...fields, charts, cards, maps },
    });

    setAbs(
      reg,
      raw.abstraction_id,
      {
        kind: "zone",
        zoneId: "__GLOBAL__",
        zoneLabel: "",
        zonePoly: [[]],
      } as any,
      pk
    );
  }

  return out;
}

/* ============================== Metrics ============================== */

export function filter_metric_abstract(
  abstract_network: HLAbstraction[]
): HLAbstraction[] {
  return (abstract_network as HLAbstraction[]).filter(
    (x) => x.model === MODEL.METRIC
  );
}

function create_metrics(
  abstract_metrics: HLAbstraction[],
  _targets: { polygons: any[]; points: any[] },
  reg: Registry,
  ids: IdRegistry
): FixtureItem[] {
  const out: FixtureItem[] = [];

  function ensureMetric(fields: any): string {
    const f = { ...DEFAULT_FIELDS, ...fields };
    if (f.category) f.category = normalizeCategory(f.category);
    if (f.interval) f.interval = normalizeInterval(f.interval);
    const key: MetricKey = `${f.category}|${f.interval}|${f.target_id}`;
    const existing = reg.metricByKey.get(key);
    if (existing) return existing;

    const mId = ids.make("m");
    const finalFields = { ...f, id: mId };
    out.push({ model: MODEL.METRIC, pk: mId, fields: finalFields });
    reg.metricByKey.set(key, mId);
    return mId;
  }

  for (const raw of abstract_metrics) {
    const kind = iterationKindFor(raw);
    const ctxs = kind === "zone" ? toZoneCtxs(reg) : toPointCtxs(reg);
    for (const ctx of ctxs) {
      const fields = deepResolve(raw.fields ?? {}, ctx, reg, ids);
      const mId = ensureMetric(fields);
      setAbs(reg, raw.abstraction_id, ctx, mId);
    }
  }
  return out;
}

/* ============================== Triggers ============================== */

export function filter_triggers(
  abstract_network: HLAbstraction[]
): HLAbstraction[] {
  return (abstract_network as HLAbstraction[]).filter(
    (x) => x.model === MODEL.TRIGGER || x.model === "metrictrigger"
  );
}

export function get_low_metrics(low_content: FixtureItem[]): FixtureItem[] {
  return low_content.filter((x) => x.model === MODEL.METRIC);
}

function resolveTokenToMetricIds(
  token: string,
  ctx: ZoneCtx | PtCtx,
  reg: Registry
): string[] {
  const ret: string[] = [];
  if (!token) return ret;

  if (!isDescriptor(token)) {
    const viaAbs = getAbs(reg, token, ctx);
    if (viaAbs) ret.push(String(viaAbs));
    return ret;
  }

  const p = parseDescriptor(token);
  if (!p) return ret;
  const { target, category, interval } = p;

  if (target.toLowerCase() === "zone") {
    if (ctx.kind !== "zone") return ret;
    const key = `${category}|${interval}|${ctx.zoneId}`;
    const mid = reg.metricByKey.get(key);
    if (mid) ret.push(mid);
    return ret;
  }

  if (
    ["pressure", "flowmeter"].includes(target.toLowerCase()) ||
    isPointCategory(category)
  ) {
    if (ctx.kind === "point") {
      const key = `${category}|${interval}|${ctx.pointId}`;
      const mid = reg.metricByKey.get(key);
      if (mid) ret.push(mid);
      return ret;
    }

    const requiredPointCat =
      category === "pressure"
        ? "pressure_sensor"
        : category.startsWith("flow_")
        ? "flow_meter"
        : undefined;

    for (const [key, mid] of reg.metricByKey.entries()) {
      const [cat, intv, tgt] = key.split("|");
      if (cat !== category || intv !== interval) continue;
      const pt = reg.pointById.get(tgt);
      if (!pt) continue;
      if (requiredPointCat && pt.category !== requiredPointCat) continue;
      if (!pointInPolygon(pt.coord, (ctx as ZoneCtx).zonePoly)) continue;
      ret.push(mid);
    }
    return ret;
  }

  return ret;
}

function create_triggers(
  _all_metrics: FixtureItem[],
  abstract_triggers: HLAbstraction[],
  _targets: { polygons: any[]; points: any[] },
  reg: Registry,
  ids: IdRegistry
): FixtureItem[] {
  const out: FixtureItem[] = [];

  for (const raw0 of abstract_triggers) {
    const raw = deepClone(raw0);
    if (raw.model === "metrictrigger") raw.model = MODEL.TRIGGER;

    const kind = iterationKindFor(raw);
    const ctxs = kind === "zone" ? toZoneCtxs(reg) : toPointCtxs(reg);

    for (const ctx of ctxs) {
      const resolved = deepResolve(raw, ctx, reg, ids);

      const calculators = (resolved.calculators ?? []).map((c: any) => {
        const args = (c.calc_args = c.calc_args ?? {});
        args.metric_id = args.metric_id || ids.guid();
        args.time_range_type = args.time_range_type || "operation";
        const inp = (args.inputs = args.inputs ?? {});
        if (!Array.isArray(inp.metrics)) inp.metrics = [];
        return c;
      });

      const inputMetrics: string[] = Array.from(
        new Set(
          (calculators ?? [])
            .flatMap((c: any) => c?.calc_args?.inputs?.metrics ?? [])
            .filter((m: any) => typeof m === "string" && m.length > 0)
        )
      );

      const outputMetric: string = resolved.output_metric || "";
      if (!outputMetric || inputMetrics.length === 0) continue;

      if (reg.triggerByOutput.has(outputMetric)) {
        const existingPk = String(reg.triggerByOutput.get(outputMetric)!);
        out.push({
          model: MODEL.TRIGGER,
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
        setAbs(reg, raw.abstraction_id, ctx, existingPk);
      } else {
        const tId = ids.make("t");
        out.push({
          model: MODEL.TRIGGER,
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
        reg.triggerByOutput.set(outputMetric, tId);
        setAbs(reg, raw.abstraction_id, ctx, tId);
      }
    }
  }

  return out;
}
