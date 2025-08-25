var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useMemo, useRef, useState } from 'react';
export default function App() {
    var _this = this;
    var _a = useState(''), rawInput = _a[0], setRawInput = _a[1];
    var _b = useState(''), formatted = _b[0], setFormatted = _b[1];
    var _c = useState(''), error = _c[0], setError = _c[1];
    var fileInputRef = useRef(null);
    var parseAndFormat = useCallback(function (text) {
        setError('');
        try {
            var obj = void 0;
            var trimmed = text.trim();
            if (!trimmed) {
                setFormatted('');
                setRawInput('');
                return;
            }
            try {
                obj = JSON.parse(trimmed);
            }
            catch (_a) {
                // NDJSON fallback
                var lines = trimmed.split(/\r?\n/).filter(Boolean);
                obj = lines.map(function (l) { return JSON.parse(l); });
            }
            var pretty = JSON.stringify(obj, null, 2);
            setFormatted(pretty);
            setRawInput(text);
        }
        catch (e) {
            setError((e === null || e === void 0 ? void 0 : e.message) || 'Failed to parse JSON.');
            setFormatted('');
        }
    }, []);
    var onFileChange = useCallback(function (e) {
        var _a;
        var file = (_a = e.target.files) === null || _a === void 0 ? void 0 : _a[0];
        if (!file)
            return;
        var reader = new FileReader();
        reader.onload = function () {
            var text = String(reader.result || '');
            parseAndFormat(text);
        };
        reader.onerror = function () { return setError('Unable to read the file.'); };
        reader.readAsText(file, 'utf-8');
    }, [parseAndFormat]);
    var onDrop = useCallback(function (ev) {
        var _a;
        ev.preventDefault();
        var file = (_a = ev.dataTransfer.files) === null || _a === void 0 ? void 0 : _a[0];
        if (!file)
            return;
        var reader = new FileReader();
        reader.onload = function () {
            var text = String(reader.result || '');
            parseAndFormat(text);
        };
        reader.onerror = function () { return setError('Unable to read the file.'); };
        reader.readAsText(file, 'utf-8');
    }, [parseAndFormat]);
    var onPaste = useCallback(function (e) {
        setTimeout(function () { return parseAndFormat(e.target.value); }, 0);
    }, [parseAndFormat]);
    var handleCopy = useCallback(function () { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!formatted)
                        return [2 /*return*/];
                    return [4 /*yield*/, navigator.clipboard.writeText(formatted)];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); }, [formatted]);
    var handleDownload = useCallback(function () {
        var blob = new Blob([formatted || rawInput], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = formatted ? 'formatted.json' : 'input.json';
        a.click();
        URL.revokeObjectURL(url);
    }, [formatted, rawInput]);
    var dropHint = useMemo(function () { return (_jsxs("ul", { className: 'list-disc text-sm pl-5 space-y-1 text-gray-600 dark:text-gray-300', children: [_jsxs("li", { children: ["Drop a ", _jsx("span", { className: 'font-medium', children: ".json" }), " file here"] }), _jsxs("li", { children: ["or click ", _jsx("span", { className: 'font-medium', children: "Browse" }), " to pick a file"] }), _jsx("li", { children: "or paste JSON directly below" })] })); }, []);
    return (_jsx("div", { className: 'min-h-screen w-full bg-gradient-to-b from-gray-50 to-white dark:from-zinc-900 dark:to-zinc-950 text-gray-900 dark:text-gray-100', children: _jsxs("div", { className: 'max-w-5xl mx-auto px-4 py-10', children: [_jsxs("header", { className: 'mb-6', children: [_jsx("h1", { className: 'text-3xl sm:text-4xl font-bold tracking-tight', children: "JSON \u2192 Viewer" }), _jsx("p", { className: 'mt-2 text-gray-600 dark:text-gray-300', children: "Upload or paste JSON. I\u2019ll pretty-print it in the large text area. (Django loaddata serialization & stable IDs coming next.)" })] }), _jsxs("section", { className: 'grid gap-6', children: [_jsxs("div", { onDragOver: function (e) { return e.preventDefault(); }, onDrop: onDrop, className: 'rounded-2xl border border-dashed border-gray-300 dark:border-zinc-700 p-6 sm:p-8 bg-white/70 dark:bg-zinc-900/50 backdrop-blur hover:border-gray-400 transition-colors', children: [_jsxs("div", { className: 'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4', children: [_jsxs("div", { children: [_jsx("h2", { className: 'text-lg font-semibold', children: "Upload JSON" }), _jsx("p", { className: 'text-sm text-gray-600 dark:text-gray-400', children: "Drag & drop or use the file picker." })] }), _jsxs("div", { className: 'flex items-center gap-3', children: [_jsx("button", { onClick: function () { var _a; return (_a = fileInputRef.current) === null || _a === void 0 ? void 0 : _a.click(); }, className: 'px-4 py-2 rounded-xl bg-gray-900 text-white dark:bg-white dark:text-zinc-900 shadow hover:opacity-90', children: "Browse\u2026" }), _jsx("button", { onClick: function () { setRawInput(''); setFormatted(''); setError(''); if (fileInputRef.current)
                                                        fileInputRef.current.value = ''; }, className: 'px-4 py-2 rounded-xl border border-gray-300 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800', children: "Clear" }), _jsx("input", { ref: fileInputRef, type: 'file', accept: 'application/json,.json,.txt', onChange: onFileChange, className: 'hidden' })] })] }), _jsx("div", { className: 'mt-4', children: dropHint })] }), _jsxs("div", { className: 'grid gap-2', children: [_jsx("label", { className: 'text-sm font-medium', children: "Paste JSON" }), _jsx("textarea", { value: rawInput, onChange: function (e) { return setRawInput(e.target.value); }, onBlur: function (e) { return parseAndFormat(e.target.value); }, onPaste: onPaste, placeholder: 'Paste JSON here\u2026', className: 'w-full h-40 sm:h-48 rounded-2xl border border-gray-300 dark:border-zinc-700 bg-white/70 dark:bg-zinc-900/50 p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500' })] }), error && (_jsxs("div", { className: 'rounded-xl border border-red-300/70 bg-red-50/70 dark:border-red-900/50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300', children: [_jsx("strong", { className: 'font-semibold', children: "Parse error:" }), " ", error] })), _jsxs("div", { className: 'grid gap-3', children: [_jsxs("div", { className: 'flex items-center justify-between', children: [_jsx("label", { className: 'text-sm font-medium', children: "Formatted JSON" }), _jsxs("div", { className: 'flex gap-2', children: [_jsx("button", { onClick: handleCopy, disabled: !formatted, className: 'px-3 py-1.5 rounded-lg border border-gray-300 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50', children: "Copy" }), _jsx("button", { onClick: handleDownload, disabled: !formatted && !rawInput, className: 'px-3 py-1.5 rounded-lg border border-gray-300 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50', children: "Download" })] })] }), _jsx("textarea", { readOnly: true, value: formatted, placeholder: 'Formatted JSON will appear here\u2026', className: 'w-full min-h-[50vh] rounded-2xl border border-gray-300 dark:border-zinc-700 bg-white/80 dark:bg-zinc-900/50 p-4 font-mono text-sm tracking-tight' })] })] }), _jsxs("footer", { className: 'mt-8 text-xs text-gray-500 dark:text-gray-400', children: ["Tip: This viewer accepts standard JSON or NDJSON (newline\u2011delimited JSON). Later we\u2019ll add a serializer that converts your input into Django ", _jsx("code", { children: "loaddata" }), " fixtures with stable IDs."] })] }) }));
}
