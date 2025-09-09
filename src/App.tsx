import { useMemo, useState, type CSSProperties } from "react";
import type { FixtureItem } from "./types";
import { buildLowLevel } from "./builders/lowLevel";
import { applyHighLevel } from "./builders/highLevel";

const boxStyle: CSSProperties = {
  width: "100%",
  minHeight: 160,
  resize: "vertical",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 12,
  lineHeight: 1.45,
  padding: "10px 12px",
  border: "1px solid #dcdcdc",
  borderRadius: 8,
  background: "#fafafa",
};

const labelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 6,
};
const smallBtn: CSSProperties = {
  fontSize: 12,
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid #ddd",
  background: "#fff",
  cursor: "pointer",
};
const primaryBtn: CSSProperties = {
  fontSize: 14,
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid #111",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
};
const toolbarStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
};

export default function App() {
  const [input1Text, setInput1Text] = useState<string>("");
  const [input2Text, setInput2Text] = useState<string>("");
  const [result, setResult] = useState<FixtureItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resultText = useMemo(
    () => (result ? JSON.stringify(result, null, 2) : ""),
    [result]
  );

  function parseJsonSafe<T = any>(text: string, name: string): T | null {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as T;
    } catch (e: any) {
      throw new Error(`${name} is not valid JSON: ${e?.message ?? e}`);
    }
  }

  function formatJson(setter: (v: string) => void, src: string) {
    try {
      if (!src.trim()) return;
      const parsed = JSON.parse(src);
      setter(JSON.stringify(parsed, null, 2));
    } catch {
      /* keep raw */
    }
  }

  function onBuild(): void {
    setError(null);
    setResult(null);
    try {
      const input1 = parseJsonSafe<any[]>(input1Text, "Input 1 (low level)");
      const input2 =
        parseJsonSafe<any[]>(input2Text, "Input 2 (high level)") ?? [];
      if (!Array.isArray(input1)) {
        throw new Error("Input 1 must be a JSON array of domain items.");
      }
      const low = buildLowLevel(input1, { strictFlowReading: true });
      const high = applyHighLevel(low, input2);
      const finalOut = [...low, ...high];
      setResult(finalOut);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  function onCopy(text: string): void {
    void navigator.clipboard?.writeText(text).catch(() => {});
  }

  function onDownload(): void {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fixture.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
            Mini Setup Wizard — Builder
          </h1>
          <div style={{ color: "#666", fontSize: 12 }}>
            Paste JSON → Build → Copy or Download
          </div>
        </div>

        <button
          style={{ ...smallBtn, opacity: result ? 1 : 0.5 }}
          onClick={onDownload}
          disabled={!result}
          title={result ? "Download fixture.json" : "Build first"}
        >
          ⬇ Download
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div>
          <div style={labelStyle}>Input 1 — Low Level (paste input_1.json)</div>
          <textarea
            placeholder='[ { "category": "zone", "label": "Zone A", "coords": [[[35,31.6],[...]]] }, ... ]'
            value={input1Text}
            onChange={(e) => setInput1Text(e.target.value)}
            style={boxStyle}
            spellCheck={false}
          />
          <div style={toolbarStyle}>
            <button
              style={smallBtn}
              onClick={() => formatJson(setInput1Text, input1Text)}
            >
              Format JSON
            </button>
            <button style={smallBtn} onClick={() => setInput1Text("")}>
              Clear
            </button>
          </div>
        </div>

        <div>
          <div style={labelStyle}>
            Input 2 — High Level (paste input_2.json)
          </div>
          <textarea
            placeholder='// Template with descriptors e.g. "MetricCategory.Zone.zone_demand.daily"'
            value={input2Text}
            onChange={(e) => setInput2Text(e.target.value)}
            style={boxStyle}
            spellCheck={false}
          />
          <div style={toolbarStyle}>
            <button
              style={smallBtn}
              onClick={() => formatJson(setInput2Text, input2Text)}
            >
              Format JSON
            </button>
            <button style={smallBtn} onClick={() => setInput2Text("")}>
              Clear
            </button>
          </div>
        </div>
      </div>

      <div
        style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}
      >
        <button style={primaryBtn} onClick={onBuild}>
          Build Fixture
        </button>
        {error && (
          <span style={{ color: "#b00020", fontSize: 13 }}>{error}</span>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle}>
          Output — loaddata JSON{" "}
          <span style={{ fontWeight: 400, color: "#888" }}>
            (copy-paste ready)
          </span>
        </div>
        <textarea
          readOnly
          value={resultText}
          placeholder="// Build to see output here"
          style={{ ...boxStyle, minHeight: 280 }}
          spellCheck={false}
        />
        <div style={toolbarStyle}>
          <button
            style={{ ...smallBtn, opacity: result ? 1 : 0.5 }}
            onClick={() => onCopy(resultText)}
            disabled={!result}
          >
            Copy Output
          </button>
          <button
            style={{ ...smallBtn, opacity: result ? 1 : 0.5 }}
            onClick={onDownload}
            disabled={!result}
          >
            Download fixture.json
          </button>
        </div>
      </div>
    </div>
  );
}
