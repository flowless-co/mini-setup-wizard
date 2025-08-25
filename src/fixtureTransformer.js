var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var DEFAULT_STORAGE_TABLE = 60; // ContentType.id
var MODEL = {
    Point: "fl_monitoring.point",
    Polygon: "fl_monitoring.polygon",
    Metric: "fl_monitoring.metricdefinition",
    Link: "fl_monitoring.link",
};
var PREFIX = {
    point: "p",
    polygon: "pl",
    metric: "m",
};
// Simple deterministic hash → 12 hex chars (DJB2-based)
function stableId(prefix, parts) {
    var key = parts.map(function (p) { return (p == null ? "" : String(p)); }).join("|");
    var s = "".concat(prefix, "::").concat(key);
    var h = 5381;
    for (var i = 0; i < s.length; i++)
        h = ((h << 5) + h) ^ s.charCodeAt(i);
    var hex8 = (h >>> 0).toString(16).padStart(8, "0");
    var hex12 = (hex8 + hex8).slice(0, 12);
    return "".concat(prefix, "-").concat(hex12);
}
// Small helpers for defaults
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
export function buildFixture(input) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (!Array.isArray(input)) {
        throw new Error("Input must be an array of items.");
    }
    var rows = [];
    var labelToTargetId = new Map();
    var zoneLabels = new Set();
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
            // Polygon fields shaped like your example:
            var fields = {
                id: pk,
                tags: "[]", // text
                coord: item.coords, // polygon coordinates array
                label: item.label,
                notes: (_a = item.notes) !== null && _a !== void 0 ? _a : item.label,
                coords: JSON.stringify(item.coords, null, 2), // stringified pretty JSON
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
        }
        else {
            // Point-like target (flow_meter / pressure_sensor / others)
            var pk = stableId(PREFIX.point, __spreadArray([
                cat,
                item.label
            ], (Array.isArray(item.coords) ? item.coords : []), true));
            // Point fields shaped like your example:
            // coord: use the [x,y]; coords: a "x, y" string for readability
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
                coords: coordsString, // string "x, y"
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
                // platform-style fields for MetricDefinition:
                tags_list: '["raw_data"]', // stringified list (as you showed)
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
    }
    // ---------- 3) Links: device ↔ zone (create 2 if inlet & outlet) ----------
    // PKs must be integers
    var nextLinkPk = 1;
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
    return rows;
}
export function buildFixtureJson(input, indent) {
    if (indent === void 0) { indent = 2; }
    return JSON.stringify(buildFixture(input), null, indent);
}
