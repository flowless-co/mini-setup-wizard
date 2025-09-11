import React, { useEffect, useMemo, useState } from "react";
import { buildLowLevel } from "./builders/lowLevel";
import { applyHighLevel } from "./builders/highLevel";
import type { FixtureItem } from "./types";

/* ------------------------ Lenient JSON utilities ------------------------ */
function stripComments(src: string): string {
  return src
    .replace(/^\uFEFF/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function stripTrailingCommas(src: string): string {
  return src.replace(/,\s*([}\]])/g, "$1");
}
function parseLenientJSON<T = any>(text: string): T {
  const t = text.trim();
  if (!t) return [] as unknown as T;
  try {
    return JSON.parse(t);
  } catch {
    const cleaned = stripTrailingCommas(stripComments(t));
    return JSON.parse(cleaned);
  }
}

/* ------------------------- Page choices from Input2 ------------------------- */
type PageChoice = { code: string; label: string };

/** Prefer fields.section.{code,label}; fallback to fields.page if section missing */
function getPageChoicesFromAbstractions(abs: any[]): PageChoice[] {
  const out: PageChoice[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(abs) ? abs : [];

  for (const a of list) {
    if (a?.model !== "fl_page_settings.pagesettings") continue;

    const fields = a.fields ?? {};
    const sectionObj =
      fields.section ?? fields?.args?.section ?? a?.args?.section ?? null;

    let code: string | null = null;
    let label: string | null = null;

    if (sectionObj && typeof sectionObj === "object") {
      code = sectionObj.code ?? null;
      label = sectionObj.label ?? sectionObj.code ?? null;
    }

    // Fallback to page only if section entirely missing
    if (!code) {
      const pageObj =
        fields.page ?? fields?.args?.page ?? a?.args?.page ?? null;
      if (typeof pageObj === "string") {
        code = pageObj;
        label = pageObj;
      } else if (pageObj && typeof pageObj === "object") {
        code = pageObj.code ?? null;
        label = pageObj.label ?? pageObj.code ?? null;
      }
    }

    if (!code) continue;
    const key = String(code);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ code: key, label: String(label ?? key) });
  }

  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/* ----------------------------- Download helper ----------------------------- */
function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ================================== App ================================== */
export default function App() {
  const [input1Text, setInput1Text] = useState<string>("");
  const [input2Text, setInput2Text] = useState<string>("");
  const [selectedPageCodes, setSelectedPageCodes] = useState<Set<string>>(
    new Set()
  );
  const [outputText, setOutputText] = useState<string>("");
  const [errors, setErrors] = useState<string | null>(null);

  // Parse Input 2 (abstractions) leniently
  const abstractions: any[] = useMemo(() => {
    if (!input2Text.trim()) return [];
    try {
      return parseLenientJSON<any[]>(input2Text);
    } catch (e: any) {
      // keep silent here; we surface errors only on Build
      return [];
    }
  }, [input2Text]);

  // Derive page choices from section.code/label
  const pageChoices = useMemo(
    () => getPageChoicesFromAbstractions(abstractions),
    [abstractions]
  );

  // Default-select all detected pages whenever the list changes
  useEffect(() => {
    setSelectedPageCodes(new Set(pageChoices.map((p) => p.code)));
  }, [pageChoices.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function togglePage(code: string) {
    setSelectedPageCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function selectAllPages(on: boolean) {
    if (on) setSelectedPageCodes(new Set(pageChoices.map((p) => p.code)));
    else setSelectedPageCodes(new Set());
  }

  function build() {
    setErrors(null);
    try {
      // 1) Parse Input 1
      const lowInput = parseLenientJSON<any[]>(input1Text);

      // 2) Build low-level
      const lowData: FixtureItem[] = buildLowLevel(lowInput);

      // 3) Build high-level scoped by selected section.codes
      const selectedPages = Array.from(selectedPageCodes);
      const highData: FixtureItem[] = applyHighLevel(
        lowData,
        abstractions,
        selectedPages
      );

      // 4) Final fixture
      const finalData = [...lowData, ...highData];
      const txt = JSON.stringify(finalData, null, 2);
      setOutputText(txt);
    } catch (e: any) {
      setErrors(e?.message || String(e));
      setOutputText("");
    }
  }

  return (
    <div
      style={{
        fontFamily: "Inter, system-ui, sans-serif",
        padding: 16,
        maxWidth: 1400,
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
        Mini Setup Wizard
      </h1>
      <p style={{ color: "#666", marginBottom: 16 }}>
        Paste <b>Input 1</b> (low) and <b>Input 2</b> (abstractions). Sections
        found in Input&nbsp;2 appear as checkboxes (from{" "}
        <code>fields.section.code/label</code>).
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Left: Inputs & selectors */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontWeight: 600 }}>Input 1 (low-level source)</label>
          <textarea
            value={input1Text}
            onChange={(e) => setInput1Text(e.target.value)}
            placeholder="Paste input_1.json here"
            style={{
              width: "100%",
              minHeight: 220,
              padding: 10,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              borderRadius: 8,
              border: "1px solid #ddd",
            }}
          />

          <label style={{ fontWeight: 600, marginTop: 12 }}>
            Input 2 (abstractions)
          </label>
          <textarea
            value={input2Text}
            onChange={(e) => setInput2Text(e.target.value)}
            placeholder="Paste input_2.json here"
            style={{
              width: "100%",
              minHeight: 220,
              padding: 10,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              borderRadius: 8,
              border: "1px solid #ddd",
            }}
          />

          <div
            style={{
              background: "#fafafa",
              border: "1px solid #eee",
              borderRadius: 8,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <strong>Sections from Input 2</strong>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => selectAllPages(true)}
                  style={{
                    padding: "4px 8px",
                    border: "1px solid #ddd",
                    borderRadius: 6,
                    background: "#fff",
                    cursor: "pointer",
                  }}
                >
                  Select all
                </button>
                <button
                  onClick={() => selectAllPages(false)}
                  style={{
                    padding: "4px 8px",
                    border: "1px solid #ddd",
                    borderRadius: 6,
                    background: "#fff",
                    cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            {pageChoices.length === 0 ? (
              <div style={{ color: "#888" }}>No sections detected yet.</div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))",
                  gap: 6,
                }}
              >
                {pageChoices.map((p) => (
                  <label
                    key={p.code}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: 6,
                      borderRadius: 6,
                      cursor: "pointer",
                    }}
                    title={p.code}
                  >
                    <input
                      type="checkbox"
                      checked={selectedPageCodes.has(p.code)}
                      onChange={() => togglePage(p.code)}
                    />
                    <span>
                      {p.label}{" "}
                      <span style={{ color: "#888" }}>({p.code})</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <button
              onClick={build}
              style={{
                marginTop: 10,
                padding: "8px 14px",
                border: "1px solid #0a7",
                background: "#0a7",
                color: "#fff",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Build
            </button>
          </div>

          {errors && (
            <div
              style={{
                marginTop: 10,
                color: "#b00020",
                whiteSpace: "pre-wrap",
              }}
            >
              <strong>Error:</strong> {errors}
            </div>
          )}
        </div>

        {/* Right: Output with small download button */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <label style={{ fontWeight: 600 }}>
              Output (combined loaddata)
            </label>
            <button
              onClick={() => downloadTextFile("data.json", outputText || "[]")}
              style={{
                padding: "6px 10px",
                border: "1px solid #ccc",
                background: "#fff",
                borderRadius: 8,
                cursor: "pointer",
              }}
              title="Download"
            >
              ⤓
            </button>
          </div>
          <textarea
            value={outputText}
            onChange={(e) => setOutputText(e.target.value)}
            placeholder="Output will appear here after Build"
            style={{
              width: "100%",
              minHeight: 520,
              padding: 10,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              borderRadius: 8,
              border: "1px solid #ddd",
            }}
          />
        </div>
      </div>
    </div>
  );
}
