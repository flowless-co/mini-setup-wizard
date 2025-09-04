import React, { useMemo, useState } from "react";
import "./index.css";

// Your existing builder + IdRegistry
import { buildFixtureJson, IdRegistry } from "./fixtureTransformer";
import { applyPages } from "./pages";

export default function App() {
  // Raw JSON text typed by the user
  const [raw, setRaw] = useState<string>("");
  // Parsed input passed to the builder
  const [input, setInput] = useState<any>([]);
  // Parse error message (if any)
  const [jsonError, setJsonError] = useState<string | null>(null);

  // JSON indentation for output
  const [indent, setIndent] = useState<number>(2);

  // Page checkboxes (start with Leak Overview enabled)
  const [pages, setPages] = useState<{ leakOverview: boolean }>({
    leakOverview: true,
  });

  const toggle = (k: keyof typeof pages) =>
    setPages((p) => ({ ...p, [k]: !p[k] }));

  const onRawChange: React.ChangeEventHandler<HTMLTextAreaElement> = (e) => {
    const value = e.target.value;
    setRaw(value);
    // Try to parse; if it fails, keep previous parsed input and surface error
    if (!value.trim()) {
      setInput([]);
      setJsonError(null);
      return;
    }
    try {
      const parsed = JSON.parse(value);
      setInput(parsed);
      setJsonError(null);
    } catch (err: any) {
      setJsonError(err?.message || "Invalid JSON");
    }
  };

  const output = useMemo(() => {
    const ids = new IdRegistry();

    // Your current buildFixtureJson signature expects (input, indent:number)
    const baseRaw: unknown = buildFixtureJson(input, indent);

    // It may return a string (serialized JSON) or an array.
    let baseArr: any[] = [];
    if (Array.isArray(baseRaw)) {
      baseArr = baseRaw as any[];
    } else {
      try {
        baseArr = JSON.parse(String(baseRaw));
      } catch {
        baseArr = [];
      }
    }

    // Apply page layer (adds page settings + charts + cards and connects them)
    applyPages(baseArr, ids, pages);

    return JSON.stringify(baseArr, null, indent);
  }, [input, indent, pages]);

  const download = () => {
    const blob = new Blob([output], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "result.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-5xl mx-auto py-8 px-4">
        <h1 className="text-2xl font-bold mb-4">Mini Setup Wizard</h1>

        {/* Pages */}
        <div className="rounded-lg bg-white border p-4 mb-4">
          <h2 className="text-lg font-semibold mb-3">Pages</h2>
          <label className="flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              checked={pages.leakOverview}
              onChange={() => toggle("leakOverview")}
            />
            <span>Leak Overview (Leak Inspector)</span>
          </label>
          <p className="text-xs text-gray-500">
            Adds page settings, charts, cards, and connects them to metrics.
          </p>
        </div>

        {/* JSON indent */}
        <div className="rounded-lg bg-white border p-4 mb-4">
          <label className="block text-sm font-medium mb-1">JSON indent</label>
          <input
            type="number"
            min={0}
            max={8}
            value={indent}
            onChange={(e) => setIndent(parseInt(e.target.value || "2", 10))}
            className="border rounded px-2 py-1 w-24"
          />
        </div>

        {/* Text input for domain JSON */}
        <div className="rounded-lg bg-white border p-4 mb-4">
          <label className="block text-sm font-medium mb-2">
            Domain input (paste JSON here)
          </label>
          <textarea
            value={raw}
            onChange={onRawChange}
            placeholder='Example: [{"category":"zone","coords":[[[35,31.6],[35.01,31.6],[35.01,31.61],[35,31.61],[35,31.6]]],"label":"Zone A"}]'
            className="w-full h-[200px] font-mono text-xs border rounded p-3"
          />
          {jsonError ? (
            <div className="mt-2 text-xs text-red-600">
              JSON Error: {jsonError}
            </div>
          ) : (
            <div className="mt-2 text-xs text-gray-500">
              Tip: You can paste either an object or an array.
            </div>
          )}
        </div>

        {/* Output */}
        <div className="rounded-lg bg-white border p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold">Output (loaddata)</h2>
            <button
              onClick={download}
              className="px-3 py-1 rounded bg-black text-white text-sm"
            >
              Download JSON
            </button>
          </div>
          <textarea
            value={output}
            readOnly
            className="w-full h-[420px] font-mono text-xs border rounded p-3"
          />
        </div>
      </div>
    </div>
  );
}
