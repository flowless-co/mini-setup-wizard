/* eslint-disable @typescript-eslint/no-explicit-any */

export function leakOverview(base: any[], _ids: any) {
  const zoneIds = getAllZoneIds(base);
  if (zoneIds.length === 0) return;

  const nextChartId = makeIntAllocator(base, "fl_page_settings.chart");
  const nextCardId = makeIntAllocator(base, "fl_page_settings.card");
  const nextPageId = makeIntAllocator(base, "fl_page_settings.pagesettings");

  // ---------- gather metrics by category across ALL zones ----------
  const demandQH = findMetricsAcrossZones(base, zoneIds, {
    category: "zone_demand",
    preferTags: ["cleaned", "raw_data"],
    preferIntervals: ["QUARTER_HOUR"],
  });
  const demandDaily = findMetricsAcrossZones(base, zoneIds, {
    category: "zone_demand",
    preferTags: ["sum_aggregated", "cleaned", "raw_data", ""],
    preferIntervals: ["DAILY", "MONTHLY"],
  });

  const leakQH = findMetricsAcrossZones(base, zoneIds, {
    category: "zone_leak",
    preferTags: ["cleaned", "raw_data", "sum_aggregated", ""],
    preferIntervals: ["QUARTER_HOUR", "DAILY", "MONTHLY"],
  });
  const azpQH = findMetricsAcrossZones(base, zoneIds, {
    category: "average_zone_pressure",
    preferTags: ["cleaned", "raw_data", ""],
    preferIntervals: ["QUARTER_HOUR"],
  });
  const azpM = findMetricsAcrossZones(base, zoneIds, {
    category: "average_zone_pressure",
    preferTags: ["normalized", "cleaned", "sum_aggregated", "raw_data", ""],
    preferIntervals: ["MONTHLY", "DAILY"],
  });

  const uarlM = findMetricsAcrossZones(base, zoneIds, {
    category: "uarl",
    preferTags: ["sum_aggregated", ""],
    preferIntervals: ["MONTHLY", "DAILY"],
  });
  const ublM = findMetricsAcrossZones(base, zoneIds, {
    category: "ubl",
    preferTags: ["sum_aggregated", ""],
    preferIntervals: ["MONTHLY", "DAILY"],
  });
  const realLossM = findMetricsAcrossZones(base, zoneIds, {
    category: "real_losses",
    preferTags: ["sum_aggregated", "financial_losses", ""],
    preferIntervals: ["MONTHLY", "DAILY"],
  });
  const mnfM = findMetricsAcrossZones(base, zoneIds, {
    category: "minimum_night_flow",
    preferIntervals: ["MONTHLY", "DAILY"],
  });
  const ndfM = findMetricsAcrossZones(base, zoneIds, {
    category: "ndf",
    preferIntervals: ["MONTHLY", "DAILY"],
  });

  const iliM = findMetricsAcrossZones(base, zoneIds, {
    category: "ili",
    preferIntervals: ["MONTHLY", "DAILY"],
  });
  const icfM = findMetricsAcrossZones(base, zoneIds, {
    category: "icf",
    preferIntervals: ["MONTHLY", "DAILY"],
  });
  const maxRecM = findMetricsAcrossZones(base, zoneIds, {
    category: "max_recoverable_leak",
    preferTags: ["normalized", ""],
    preferIntervals: ["MONTHLY", "DAILY"],
  });

  const union = (...groups: string[][]) =>
    Array.from(new Set(groups.flat().filter(Boolean)));

  const chartIds: number[] = [];

  // ---------- CHART 1: Demand vs Leak (always shows if we have demand) ----------
  const ch1MetricsLeft = union(demandQH, leakQH);
  const ch1MetricsRight = azpQH; // may be empty
  const ch1All = union(ch1MetricsLeft, ch1MetricsRight);
  if (ch1All.length) {
    const ch1 = newChart(base, nextChartId, {
      label: "Demand Vs Leak",
      category: "demand_vs_leak",
      chart_type: "multi_charts",
      datetime_range: "last_72_hour",
      metrics: ch1All,
      args: {
        label: "Demand Vs Leak",
        x_label: "",
        y_label_left: "Flow Rate (m³/h)",
        y_label_right: "Pressure (m)",
        types: [
          {
            fill: true,
            type: "line",
            y_axis: "left",
            stacked: false,
            beginAtZero: true,
            metrics: ch1MetricsLeft,
            metrics_categories: ["zone_demand", "zone_leak"],
          },
          {
            fill: false,
            type: "line",
            y_axis: "right",
            stacked: false,
            beginAtZero: true,
            metrics: ch1MetricsRight,
            metrics_categories: ["average_zone_pressure"],
          },
        ],
        cards_metric_id: ch1All,
        default_alert_metric: "",
      },
    });
    chartIds.push(ch1);
  }

  // ---------- CHART 2: Zone Monthly Leak Profile with robust fallback ----------
  let ch2Left = union(uarlM, ublM, realLossM, mnfM, ndfM);
  let ch2Right = azpM;
  let ch2All = union(ch2Left, ch2Right);

  // Fallback to Daily Demand if no leak-profile metrics exist
  if (ch2All.length === 0) {
    if (demandDaily.length === 0 && demandQH.length > 0) {
      // last resort: use QH demand
      ch2Left = demandQH;
    } else {
      ch2Left = demandDaily;
    }
    ch2Right = []; // no pressure available
    ch2All = ch2Left;
  }

  if (ch2All.length) {
    const ch2 = newChart(base, nextChartId, {
      label: "Zone Monthly Leak Profile",
      category: "zone_monthly_leak_profile",
      chart_type: "multi_charts",
      datetime_range: "last_30_days",
      metrics: ch2All,
      args: {
        label: "Zone Monthly Leak Profile",
        x_label: "",
        y_label_left:
          ch2Left === demandDaily ? "Flow Volume (m³/day)" : "Flow Volume (m³)",
        y_label_right: "Pressure (m)",
        types: [
          {
            fill: true,
            type: "line",
            y_axis: "left",
            stacked: false,
            beginAtZero: true,
            metrics: ch2Left,
            metrics_categories:
              ch2Left === demandDaily
                ? ["zone_demand"]
                : ["uarl", "ubl", "real_losses", "minimum_night_flow", "ndf"],
          },
          {
            fill: false,
            type: "line",
            y_axis: "right",
            stacked: false,
            beginAtZero: true,
            metrics: ch2Right,
            metrics_categories: ["average_zone_pressure"],
          },
        ],
        cards_metric_id: ch2Left,
        default_alert_metric: "",
      },
    });
    chartIds.push(ch2);
  }

  // ---------- CHART 3: Leak Components (Sankey) — only if we have meaningful pairs ----------
  const sankeyPairs: { from_metric: string; to_metric: string }[] = [];
  for (const z of zoneIds) {
    const leak = bestForZone(union(leakQH, realLossM), base, z);
    const uarl = bestForZone(uarlM, base, z);
    const ubl = bestForZone(ublM, base, z);
    const maxR = bestForZone(maxRecM, base, z);
    if (leak && uarl) sankeyPairs.push({ from_metric: leak, to_metric: uarl });
    if (leak && ubl) sankeyPairs.push({ from_metric: leak, to_metric: ubl });
    if (uarl && maxR) sankeyPairs.push({ from_metric: uarl, to_metric: maxR });
  }
  const ch3All = union(leakQH, uarlM, ublM, realLossM, maxRecM);
  if (sankeyPairs.length && ch3All.length) {
    const ch3 = newChart(base, nextChartId, {
      label: "Leak Components",
      category: "leak_components_analysis",
      chart_type: "sankey",
      datetime_range: "latest",
      metrics: ch3All,
      args: {
        sankey_data: sankeyPairs,
        cards_metric_id: union(uarlM, ublM),
      },
    });
    chartIds.push(ch3);
  }

  // ---------- CHART 4: Leak Pies with fallback ----------
  const pies: any[] = [];
  const leakDaily = findMetricsAcrossZones(base, zoneIds, {
    category: "zone_leak",
    preferTags: ["sum_aggregated", ""],
    preferIntervals: ["DAILY", "MONTHLY"],
  });

  // Preferred pies
  if (demandDaily.length && leakDaily.length) {
    pies.push({
      label: "Consumption Vs Leak",
      metrics: union(demandDaily, leakDaily),
      describes: ["DAILY"],
    });
  }
  if (uarlM.length && ublM.length) {
    pies.push({
      label: "Fixed Area Vs Variable Area",
      metrics: union(uarlM, ublM),
      describes: ["MONTHLY"],
    });
  }

  // Fallback: Demand share by zone
  if (pies.length === 0 && demandDaily.length) {
    pies.push({
      label: "Demand Share by Zone",
      metrics: demandDaily,
      describes: ["DAILY"],
    });
  }

  const ch4All = Array.from(new Set(pies.flatMap((p) => p.metrics)));
  if (ch4All.length) {
    const ch4 = newChart(base, nextChartId, {
      label: "Leak Pies",
      category: "leak_components_pies",
      chart_type: "pies",
      datetime_range: "latest",
      metrics: ch4All,
      args: { pies },
    });
    chartIds.push(ch4);
  }

  // ---------- CARDS (remain category-based; will be empty if those metrics don’t exist) ----------
  const cardILI = newCard(base, nextCardId, {
    label: "Infrastructure Leakage Index (ILI)",
    code: "FilteredMetricCard",
    card_category: "",
    args: {
      icon_code: "material-symbols-light:water-drop-outline",
      description: "",
      target_id: [],
      metric_ids: iliM,
    },
  });
  const cardICF = newCard(base, nextCardId, {
    label: "ICF",
    code: "FilteredMetricCard",
    card_category: "",
    args: {
      icon_code: "material-symbols-light:water-drop-outline",
      description: "",
      target_id: [],
      metric_ids: icfM,
    },
  });
  const cardReal = newCard(base, nextCardId, {
    label: "Real Losses (Monthly)",
    code: "FilteredMetricCard",
    card_category: "",
    args: {
      icon_code: "hugeicons:chart",
      description: "",
      target_id: [],
      metric_ids: realLossM,
    },
  });
  const cardMaxRec = newCard(base, nextCardId, {
    label: "Max Recoverable Leak",
    code: "FilteredMetricCard",
    card_category: "",
    args: {
      icon_code: "hugeicons:chart",
      description: "",
      target_id: [],
      metric_ids: maxRecM,
    },
  });

  // ---------- PAGE ----------
  const pageId = nextPageId();
  base.push({
    model: "fl_page_settings.pagesettings",
    pk: pageId,
    fields: {
      id: pageId,
      label: "Leak Overview",
      page: "fl_leak_inspector",
      users: [],
      maps: [],
      schematics: [],
      charts: chartIds, // include ONLY charts that have metrics
      cards: [cardILI, cardICF, cardReal, cardMaxRec],
      args: {
        page: {
          code: "fl_leak_inspector",
          icon: "hugeicons:blur",
          label: "Leak Inspector",
          services: [],
          menu_label: "",
        },
        section: {
          code: "fl_leak_overview",
          icon: "material-symbols:water-medium-outline-rounded",
          label: "Leak Overview",
          description: "Leak Overview",
          section_order: 1,
          page_description: "Leak Overview",
        },
        components: {
          constants: false,
          latest_metrics: false,
          metadata_block: true,
          constants_block: true,
          target_metric_tree: false,
          latest_multi_viewer: false,
        },
        dynamic_filter: {
          show: true,
          enable: true,
          filters: [
            {
              code: "target_filter",
              label: "Target",
              args: {
                target_type: "",
                target_category: "zone",
                default_value: "",
              },
            },
            {
              code: "period_filter",
              label: "Period",
              args: { input_type: "datetime", default_value: "current_month" },
            },
          ],
        },
        embeds: [],
        image_mapper: [],
        charts_settings: { default_view: "grid" },
        general_prompt: [],
        specific_prompt: [],
        page_section_type: "dynamic_page",
      },
    },
  });
}

/* ----------------------- helpers (unchanged) ----------------------- */

function getAllZoneIds(items: any[]): string[] {
  const ids = new Set<string>();
  for (const x of items) {
    if (x?.model === "fl_monitoring.polygon") {
      const id = String(x.pk ?? x.fields?.id ?? "");
      if (id) ids.add(id);
    }
  }
  return Array.from(ids);
}

type FindMetricOpts = {
  category: string;
  preferTags?: string[];
  preferIntervals?: string[];
};

function findMetricsAcrossZones(
  items: any[],
  zoneIds: string[],
  { category, preferTags = [], preferIntervals = [] }: FindMetricOpts
): string[] {
  const byZone: Record<string, any[]> = {};
  for (const it of items) {
    if (it?.model !== "fl_monitoring.metricdefinition") continue;
    const f = it.fields || {};
    if (f.category !== category) continue;
    const tid = String(f.target_id || "");
    if (!zoneIds.includes(tid)) continue;
    (byZone[tid] ||= []).push(it);
  }
  const chosen: string[] = [];
  for (const z of zoneIds) {
    const list = byZone[z];
    if (!list || !list.length) continue;
    const best = pickBestMetric(list, preferTags, preferIntervals);
    if (best) chosen.push(best);
  }
  return chosen;
}

function pickBestMetric(
  candidates: any[],
  preferTags: string[],
  preferIntervals: string[]
) {
  const scored = candidates
    .map((x) => {
      const f = x.fields || {};
      const tags = parseTagsList(f.tags_list);
      const interval = String(f.interval || f.describes || "");
      const tagScore = preferTags.length
        ? scoreIndex(
            tags.find((t) => preferTags.includes(t)),
            preferTags
          )
        : 0;
      const intScore = preferIntervals.length
        ? scoreIndex(interval, preferIntervals)
        : 0;
      return {
        id: String(f.id),
        score: tagScore * 10 + intScore,
        interval,
        tags,
      };
    })
    .sort((a, b) => a.score - b.score);
  return scored[0]?.id;
}

function parseTagsList(v: any): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.map(String);
    } catch {}
  }
  return [];
}

function scoreIndex(value: string | undefined, order: string[]): number {
  const i = value ? order.indexOf(value) : -1;
  return i >= 0 ? i : order.length + 1;
}

function makeIntAllocator(items: any[], model: string) {
  const nums: number[] = [];
  for (const it of items) {
    if (!it || it.model !== model) continue;
    const pk = toInt(it.pk);
    const fid = toInt(it.fields?.id);
    if (pk != null) nums.push(pk);
    if (fid != null) nums.push(fid);
  }
  let next = (nums.length ? Math.max(...nums) : 0) + 1;
  return () => next++;
}

function toInt(v: any): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function newChart(
  base: any[],
  alloc: () => number,
  fields: Record<string, any>
): number {
  const id = alloc();
  base.push({
    model: "fl_page_settings.chart",
    pk: id,
    fields: { id, ...fields },
  });
  return id;
}

function newCard(
  base: any[],
  alloc: () => number,
  fields: Record<string, any>
): number {
  const id = alloc();
  base.push({
    model: "fl_page_settings.card",
    pk: id,
    fields: { id, ...fields },
  });
  return id;
}

function bestForZone(
  candidates: string[],
  items: any[],
  zoneId: string
): string | undefined {
  const set = new Set(candidates);
  const matches = items.filter(
    (it) =>
      it?.model === "fl_monitoring.metricdefinition" &&
      set.has(String(it.fields?.id)) &&
      it.fields?.target_id === zoneId
  );
  if (!matches.length) return undefined;
  return String(matches[0].fields.id);
}
