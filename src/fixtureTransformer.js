var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var DEFAULT_STORAGE_TABLE = 60; // sensor/raw ContentType.id
var DEFAULT_FORMULA_STORAGE_TABLE = 68; // formula/derived ContentType.id
var MODEL = {
    Point: "fl_monitoring.point",
    Polygon: "fl_monitoring.polygon",
    Metric: "fl_monitoring.metricdefinition",
    Link: "fl_monitoring.link",
    Trigger: "fl_dispatcher.metrictrigger",
};
var PREFIX = {
    point: "p",
    polygon: "pl",
    metric: "m",
    trigger: "t",
};
// ---------- Deterministic IDs ----------
function stableId(prefix, parts) {
    var key = parts.map(function (p) { return (p == null ? "" : String(p)); }).join("|");
    var s = "".concat(prefix, "::").concat(key);
    var h = 5381;
    for (var i = 0; i < s.length; i++)
        h = ((h << 5) + h) ^ s.charCodeAt(i);
    var hex8 = (h >>> 0).toString(16);
    while (hex8.length < 8)
        hex8 = "0" + hex8;
    var hex12 = (hex8 + hex8).slice(0, 12);
    return "".concat(prefix, "-").concat(hex12);
}
function _hex8(n) {
    var s = (n >>> 0).toString(16);
    while (s.length < 8)
        s = "0" + s;
    return s;
}
/** Deterministic UUID-like (no randomness) for calculators[*].calc_args.metric_id */
function stableUuid(parts) {
    var key = parts.map(function (p) { return (p == null ? "" : String(p)); }).join("|");
    var h1 = 5381, h2 = 52711, h3 = 33, h4 = 1315423911;
    for (var i = 0; i < key.length; i++) {
        var c = key.charCodeAt(i);
        h1 = ((h1 << 5) + h1) ^ c;
        h2 = ((h2 << 5) + h2) ^ (c + 1);
        h3 = ((h3 << 5) + h3) ^ (c + 2);
        h4 = ((h4 << 5) + h4) ^ (c + 3);
    }
    var hex32 = _hex8(h1) + _hex8(h2) + _hex8(h3) + _hex8(h4);
    return (hex32.slice(0, 8) +
        "-" +
        hex32.slice(8, 12) +
        "-" +
        hex32.slice(12, 16) +
        "-" +
        hex32.slice(16, 20) +
        "-" +
        hex32.slice(20, 32));
}
// ---------- Small helpers ----------
function defaultIconCodeForCategory(cat) {
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
function outerRing(coords) {
    // Accept:
    //  Polygon: [ [ [x,y], ... ] ]
    //  MultiPolygon: [ [ [ [x,y], ... ] ], ... ]
    if (!Array.isArray(coords))
        return [];
    // Polygon → take first ring
    if (coords.length > 0 &&
        Array.isArray(coords[0]) &&
        Array.isArray(coords[0][0]) &&
        typeof coords[0][0][0] === "number") {
        return coords[0];
    }
    // MultiPolygon → take first polygon's first ring
    if (coords.length > 0 &&
        Array.isArray(coords[0]) &&
        Array.isArray(coords[0][0]) &&
        Array.isArray(coords[0][0][0])) {
        return coords[0][0];
    }
    return [];
}
function pointInRing(point, ring) {
    var x = point[0], y = point[1];
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var _a = ring[i], xi = _a[0], yi = _a[1];
        var _b = ring[j], xj = _b[0], yj = _b[1];
        var intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi; // avoid /0
        if (intersect)
            inside = !inside;
    }
    return inside;
}
function pointInPolygon(point, polyCoords) {
    var ring = outerRing(polyCoords);
    return ring.length >= 3 ? pointInRing(point, ring) : false;
}
export function buildFixture(input) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (!Array.isArray(input)) {
        throw new Error("Input must be an array of items.");
    }
    var rows = [];
    // Lookups we’ll need
    var labelToTargetId = new Map();
    var zoneLabels = new Set();
    var zoneGeoms = new Map(); // label -> coords
    var pointCoordsByLabel = new Map(); // label -> [x,y]
    // Reading metrics we create first
    var flowReadingMetricByLabel = new Map(); // label -> m-...
    var flowReadingMetaByLabel = new Map();
    var pressureReadingMetricByLabel = new Map();
    var pressureReadingMetaByLabel = new Map();
    // Flow Volume metrics (derived from flow readings)
    var flowVolumeMetricByLabel = new Map();
    // ---------- 1) Targets: Points / Polygons ----------
    for (var _i = 0, input_1 = input; _i < input_1.length; _i++) {
        var raw = input_1[_i];
        var item = raw;
        if (!item || !item.category || !item.label) {
            throw new Error("Each item must include at least { category, label }.");
        }
        var cat = String(item.category).toLowerCase();
        if (cat === "zone") {
            var pk = stableId(PREFIX.polygon, ["zone", item.label]);
            var fields = {
                id: pk,
                tags: "[]", // text
                coord: item.coords, // polygon coordinates array
                label: item.label,
                notes: (_a = item.notes) !== null && _a !== void 0 ? _a : item.label,
                coords: JSON.stringify(item.coords, null, 2), // pretty string
                category: "zone",
                attribute: (_b = item.attribute) !== null && _b !== void 0 ? _b : {
                    metadata: [],
                    icon_code: defaultIconCodeForCategory("zone"),
                    icon_size: 1,
                },
                is_active: true,
                tags_list: Array.isArray(item.tags_list) ? item.tags_list : [],
            };
            rows.push({ model: MODEL.Polygon, pk: pk, fields: fields });
            labelToTargetId.set(item.label, pk);
            zoneLabels.add(item.label);
            zoneGeoms.set(item.label, item.coords);
        }
        else {
            // flow_meter / pressure_sensor (point-like)
            var pk = stableId(PREFIX.point, __spreadArray([
                cat,
                item.label
            ], (Array.isArray(item.coords) ? item.coords : []), true));
            var pointArray = Array.isArray(item.coords)
                ? item.coords
                : [null, null];
            var coordsString = pointArray.length >= 2 &&
                typeof pointArray[0] === "number" &&
                typeof pointArray[1] === "number"
                ? "".concat(pointArray[0], ", ").concat(pointArray[1])
                : "";
            var fields = {
                id: pk,
                tags: "[]", // text
                coord: pointArray, // [x, y]
                label: item.label,
                notes: (_c = item.notes) !== null && _c !== void 0 ? _c : item.label,
                coords: coordsString, // "x, y"
                category: cat,
                attribute: (_d = item.attribute) !== null && _d !== void 0 ? _d : {
                    metadata: [],
                    icon_code: defaultIconCodeForCategory(cat),
                    icon_size: 1,
                },
                is_active: true,
                tags_list: Array.isArray(item.tags_list) ? item.tags_list : [],
            };
            rows.push({ model: MODEL.Point, pk: pk, fields: fields });
            labelToTargetId.set(item.label, pk);
            if (Array.isArray(pointArray) &&
                pointArray.length >= 2 &&
                typeof pointArray[0] === "number" &&
                typeof pointArray[1] === "number") {
                pointCoordsByLabel.set(item.label, pointArray);
            }
        }
    }
    // ---------- 2) Metrics: only for flow_meter / pressure_sensor ----------
    for (var _h = 0, input_2 = input; _h < input_2.length; _h++) {
        var raw = input_2[_h];
        var item = raw;
        var cat = String(item.category || "").toLowerCase();
        if (!(cat === "flow_meter" || cat === "pressure_sensor"))
            continue;
        var targetId = labelToTargetId.get(item.label);
        if (!targetId)
            continue;
        var metricCategory = (item.metric_category ||
            (cat === "flow_meter" ? "flow_reading" : "pressure_reading")).toString();
        var defaultUnit = cat === "flow_meter" ? "m³" : "m";
        var unit = ((_e = item.metric_unit) !== null && _e !== void 0 ? _e : defaultUnit).toString();
        var interval = ((_f = item.metric_interval) !== null && _f !== void 0 ? _f : "IRREGULAR").toString();
        var metricLabel = "".concat(metricCategory, " - ").concat(item.label);
        var pk = stableId(PREFIX.metric, [
            metricCategory,
            item.label,
            unit,
            interval,
        ]);
        var storage_table = (_g = item.metric_storage_table) !== null && _g !== void 0 ? _g : DEFAULT_STORAGE_TABLE;
        if (storage_table == null) {
            throw new Error("Metric for \"".concat(item.label, "\" is missing storage_table. ") +
                "Set DEFAULT_STORAGE_TABLE or provide metric_storage_table in input.");
        }
        rows.push({
            model: MODEL.Metric,
            pk: pk,
            fields: {
                label: metricLabel,
                category: metricCategory,
                unit: unit,
                interval: interval,
                tags_list: '["raw_data"]', // stringified list for MetricDefinition
                target_id: targetId,
                storage_table: storage_table, // FK to ContentType.id (integer)
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
            flowReadingMetaByLabel.set(item.label, { unit: unit, interval: interval });
        }
        if (metricCategory === "pressure_reading") {
            pressureReadingMetricByLabel.set(item.label, pk);
            pressureReadingMetaByLabel.set(item.label, { unit: unit, interval: interval });
        }
    }
    // ---------- 3) Links: device ↔ zone (create 2 if inlet & outlet) ----------
    var nextLinkPk = 1; // PKs must be integers
    for (var _j = 0, input_3 = input; _j < input_3.length; _j++) {
        var raw = input_3[_j];
        var item = raw;
        var cat = String(item.category || "").toLowerCase();
        if (!(cat === "flow_meter" || cat === "pressure_sensor"))
            continue;
        var deviceId = labelToTargetId.get(item.label);
        if (!deviceId)
            continue;
        if (item.inletFor && zoneLabels.has(item.inletFor)) {
            var zoneId = labelToTargetId.get(item.inletFor);
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
            var zoneId = labelToTargetId.get(item.outletFor);
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
    flowReadingMetricByLabel.forEach(function (readingMetricId, lbl) {
        var meta = flowReadingMetaByLabel.get(lbl) || {
            unit: "m³",
            interval: "IRREGULAR",
        };
        var deviceId = labelToTargetId.get(lbl);
        if (!deviceId)
            return;
        var volumeMetricId = stableId(PREFIX.metric, [
            "flow_volume",
            lbl,
            meta.unit,
            meta.interval,
        ]);
        rows.push({
            model: MODEL.Metric,
            pk: volumeMetricId,
            fields: {
                label: "Flow Volume - ".concat(lbl),
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
        var trigId = stableId(PREFIX.trigger, ["flow_volume", lbl]);
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
                description: "Flow Volume - ".concat(lbl),
                schedule_job: "",
                input_metrics: [readingMetricId],
                output_metric: volumeMetricId,
            },
        });
    });
    // Build zone → inputs
    var zoneToFlowVolumeInputs = new Map(); // zone -> [m-...]
    var zoneToPressureInputs = new Map(); // zone -> [m-...]
    zoneLabels.forEach(function (zlbl) {
        var zcoords = zoneGeoms.get(zlbl);
        var flowVols = [];
        var pressReads = [];
        pointCoordsByLabel.forEach(function (pt, lbl) {
            if (!Array.isArray(pt))
                return;
            if (!pointInPolygon(pt, zcoords))
                return;
            var fv = flowVolumeMetricByLabel.get(lbl);
            if (fv)
                flowVols.push(fv);
            var pr = pressureReadingMetricByLabel.get(lbl);
            if (pr)
                pressReads.push(pr);
        });
        if (flowVols.length)
            zoneToFlowVolumeInputs.set(zlbl, flowVols);
        if (pressReads.length)
            zoneToPressureInputs.set(zlbl, pressReads);
    });
    // ---------- 5) Zone Demand: per zone (inputs = flow volumes in zone) ----------
    var AGG_GROUPS = ["year", "month", "day", "hour", "quarter_hour"];
    zoneToFlowVolumeInputs.forEach(function (inputMetricIds, zlbl) {
        var zoneId = labelToTargetId.get(zlbl);
        if (!zoneId)
            return;
        var zMetricId = stableId(PREFIX.metric, [
            "zone_demand",
            zlbl,
            "m³",
            "QUARTER_HOUR",
        ]);
        rows.push({
            model: MODEL.Metric,
            pk: zMetricId,
            fields: {
                label: "".concat(zlbl, " - Demand"),
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
        var trigId = stableId(PREFIX.trigger, ["zone_demand", zlbl]);
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
                description: "".concat(zlbl, " - Demand"),
                schedule_job: "",
                input_metrics: inputMetricIds,
                output_metric: zMetricId,
            },
        });
    });
    // ---------- 6) AZP: per zone ----------
    zoneToPressureInputs.forEach(function (inputMetricIds, zlbl) {
        var zoneId = labelToTargetId.get(zlbl);
        if (!zoneId)
            return;
        var azpMetricId = stableId(PREFIX.metric, [
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
                label: "".concat(zlbl, " - Average zone pressure"),
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
        var trigId = stableId(PREFIX.trigger, ["azp", zlbl]);
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
                description: "".concat(zlbl, " - Average Zone Pressure"),
                schedule_job: null,
                input_metrics: inputMetricIds,
                output_metric: azpMetricId,
            },
        });
    });
    return rows;
}
export function buildFixtureJson(input, indent) {
    if (indent === void 0) { indent = 2; }
    return JSON.stringify(buildFixture(input), null, indent);
}
