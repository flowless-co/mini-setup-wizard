# JSON → Viewer (Milestone 1)

A minimal Vite + React + TypeScript + Tailwind app to upload/paste JSON and pretty‑print it.

## Quickstart

```bash
# 1) Extract and enter the directory
unzip json-viewer-app.zip && cd json-viewer-app

# 2) Install deps
npm install

# 3) Run dev server
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Features
- Drag & drop or browse a .json file
- Paste JSON or NDJSON
- Pretty-printed output in a large read-only text area
- Copy / Download buttons

## Next milestone
- Transform input into Django `loaddata` fixtures
- Deterministic, collision-resistant ID generation (per-model prefix + salted SHA-256)
