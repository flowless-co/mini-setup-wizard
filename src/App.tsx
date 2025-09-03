import React, { useCallback, useMemo, useRef, useState } from "react";
import { buildFixtureJson } from "./fixtureTransformer";

export default function App() {
  const [rawInput, setRawInput] = useState<string>("");
  const [formatted, setFormatted] = useState<string>("");
  const [error, setError] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);

  const parseAndFormat = useCallback((text: string) => {
    setError("");
    try {
      let obj: any;
      const trimmed = text.trim();
      if (!trimmed) {
        setFormatted("");
        setRawInput("");
        return;
      }
      try {
        obj = JSON.parse(trimmed);
      } catch {
        // NDJSON fallback
        const lines = trimmed.split(/\r?\n/).filter(Boolean);
        obj = lines.map((l) => JSON.parse(l));
      }
      const pretty = JSON.stringify(obj, null, 2);
      setFormatted(pretty);
      setRawInput(text);
    } catch (e: any) {
      setError(e?.message || "Failed to parse JSON.");
      setFormatted("");
    }
  }, []);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        parseAndFormat(text);
      };
      reader.onerror = () => setError("Unable to read the file.");
      reader.readAsText(file, "utf-8");
    },
    [parseAndFormat]
  );

  const onDrop = useCallback(
    (ev: React.DragEvent<HTMLDivElement>) => {
      ev.preventDefault();
      const file = ev.dataTransfer.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        parseAndFormat(text);
      };
      reader.onerror = () => setError("Unable to read the file.");
      reader.readAsText(file, "utf-8");
    },
    [parseAndFormat]
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      setTimeout(
        () => parseAndFormat((e.target as HTMLTextAreaElement).value),
        0
      );
    },
    [parseAndFormat]
  );

  const handleCopy = useCallback(async () => {
    if (!formatted) return;
    await navigator.clipboard.writeText(formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [formatted]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([formatted || rawInput], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = formatted ? "formatted.json" : "input.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [formatted, rawInput]);

  const dropHint = useMemo(
    () => (
      <ul className="list-disc text-sm pl-5 space-y-1 text-gray-600 dark:text-gray-300">
        <li>
          Drop a <span className="font-medium">.json</span> file here
        </li>
        <li>
          or click <span className="font-medium">Browse</span> to pick a file
        </li>
        <li>or paste JSON directly below</li>
      </ul>
    ),
    []
  );

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-gray-50 to-white dark:from-zinc-900 dark:to-zinc-950 text-gray-900 dark:text-gray-100">
      <div className="max-w-5xl mx-auto px-4 py-10">
        <header className="mb-8">
          <div className="flex items-center gap-4 sm:gap-5">
            <link rel="icon" type="image/png" href="/flowless-icon.png" />
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
                Flowless Setup Wizard 🧙‍♂️
              </h1>
              <p className="mt-2 text-gray-600 dark:text-gray-300">
                Upload or paste JSON. I’ll pretty-print it in the large text
                area. Then generate your content setup.
              </p>
            </div>
          </div>
        </header>

        <section className="grid gap-6">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="rounded-2xl border border-dashed border-gray-300 dark:border-zinc-700 p-6 sm:p-8 bg-white/70 dark:bg-zinc-900/50 backdrop-blur hover:border-gray-400 transition-colors"
          >
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Upload JSON</h2>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Drag & drop or use the file picker.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-2 rounded-xl bg-gray-900 text-white dark:bg-white dark:text-zinc-900 shadow hover:opacity-90"
                >
                  Browse…
                </button>
                <button
                  onClick={() => {
                    setRawInput("");
                    setFormatted("");
                    setError("");
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="px-4 py-2 rounded-xl border border-gray-300 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800"
                >
                  Clear
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json,.txt"
                  onChange={onFileChange}
                  className="hidden"
                />
              </div>
            </div>
            <div className="mt-4">{dropHint}</div>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium">Paste JSON</label>
            <textarea
              value={rawInput}
              onChange={(e) => setRawInput(e.target.value)}
              onBlur={(e) => parseAndFormat(e.target.value)}
              onPaste={onPaste}
              placeholder="Paste JSON here…"
              className="w-full h-40 sm:h-48 rounded-2xl border border-gray-300 dark:border-zinc-700 bg-white/70 dark:bg-zinc-900/50 p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-red-300/70 bg-red-50/70 dark:border-red-900/50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
              <strong className="font-semibold">Parse error:</strong> {error}
            </div>
          )}

          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Formatted JSON</label>
              <div className="flex gap-2">
                <button
                  onClick={handleCopy}
                  disabled={!formatted}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                >
                  {copied ? "✅ Copied!" : "Copy"}
                </button>

                <button
                  onClick={handleDownload}
                  disabled={!formatted && !rawInput}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                >
                  Download
                </button>

                {/* Generate content setup */}
                <button
                  onClick={() => {
                    try {
                      const parsed = JSON.parse(rawInput.trim());
                      const fixture = buildFixtureJson(parsed, 2, {
                        fullZoneSuite: true,
                        keepExisting: true,
                      });
                      setFormatted(fixture);
                      setError("");
                    } catch (e: any) {
                      setError(
                        e?.message ||
                          "Failed to transform to content setup fixture."
                      );
                    }
                  }}
                  disabled={!rawInput.trim()}
                  className="px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50"
                >
                  Generate Content Setup
                </button>
              </div>
            </div>
            <textarea
              readOnly
              value={formatted}
              placeholder="Formatted JSON will appear here…"
              className="w-full min-h-[50vh] rounded-2xl border border-gray-300 dark:border-zinc-700 bg-white/80 dark:bg-zinc-900/50 p-4 font-mono text-sm tracking-tight"
            />
          </div>
        </section>

        <footer className="mt-8 text-xs text-gray-500 dark:text-gray-400">
          Tip: This Wizard accepts standard JSON or NDJSON (newline-delimited
          JSON).
        </footer>
      </div>
    </div>
  );
}
