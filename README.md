# BPMN DSL → Camunda-style BPMN (XML + UI)

This repo contains a small toolchain:

- **`bpmn-parser/` (Rust)**: builds the **OGB** binary that parses the DSL and generates **BPMN 2.0 XML with BPMN DI** (coordinates).
- **`bpmn-ui/server/` (Node/Express)**: HTTP API that runs the parser and returns generated XML.
- **`bpmn-ui/web/` (React + bpmn-js)**: web UI to paste DSL, generate XML, and view/edit the diagram.

## Prerequisites

- **Rust** (for `ogb` binary): install via rustup
- **Node.js + npm** (for UI): any recent LTS is fine

## Quick start (Windows / macOS / Linux)

### 1) Build the parser (Rust)

From the repo root:

```bash
cd bpmn-parser
cargo build --release
```

### 2) Start the API server

In a new terminal:

```bash
cd bpmn-ui/server
npm install
npm run dev
```

The server automatically prefers the **release** OGB binary if it exists:

- `bpmn-parser/target/release/ogb(.exe)`

Optional override (if you want to point to a custom build):

- Windows PowerShell:

```powershell
$env:BPMN_PARSER_EXE="C:\path\to\ogb.exe"
npm run dev
```

- macOS/Linux:

```bash
BPMN_PARSER_EXE="/path/to/ogb" npm run dev
```

Health check:

- `GET http://localhost:5175/api/health`

### 3) Start the web UI (dev)

In another terminal:

```bash
cd bpmn-ui/web
npm install
npm run dev
```

The web dev server proxies `/api/*` to `http://localhost:5175` (see `bpmn-ui/web/vite.config.ts`).

## Usage

1) Paste DSL into the UI textarea.
2) Click **Generate from DSL**.
3) The UI loads BPMN XML into **bpmn-js Modeler**, where you can edit and export `.bpmn`.

## Universal AI prompt (Confluence → DSL)

See **`PROMPT_AND_USAGE.md`**.

## Troubleshooting

- **Port already in use**
  - Stop the running process (Ctrl+C) or change port via `PORT` env var for the server.
- **Web shows `/api/*` proxy errors**
  - Ensure the API server is running on `http://localhost:5175`.

### Task type prefixes in DSL

Steps can start with explicit type prefixes (they affect BPMN element type and are stripped from the visible label):

- `[API]` → `serviceTask`
- `[SCRIPT]` → `scriptTask`
- `[MANUAL]` → `manualTask`
- `[AUTO]` → regular `task`
- `[DB]` → `serviceTask`
- `[MSG]` → `serviceTask`

Example:

```text
= Process
== Main
# Start
- [API] GET /portfolio
- [SCRIPT] Calculate amount_to_debit
. End
```

## Project layout

- `bpmn-parser/`: DSL lexer/parser + layout + BPMN XML/DI generator
- `bpmn-ui/server/`: `/api/generate` and `/api/convert`
- `bpmn-ui/web/`: React UI with bpmn-js modeler

## Notes

- `node_modules/`, `dist/`, and generated BPMN files are ignored by git (see `.gitignore`).
