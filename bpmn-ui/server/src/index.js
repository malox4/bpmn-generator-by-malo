import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

// Don't crash or spam stack traces on malformed JSON bodies.
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  next(err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../");
const webDistDir = path.join(repoRoot, "bpmn-ui", "web", "dist");

// Serve built web UI from the same port (avoids dev-port conflicts).
if (fsSync.existsSync(webDistDir)) {
  app.use(express.static(webDistDir));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(webDistDir, "index.html"));
  });
}

function resolveBpmnParserExe() {
  const exeExt = process.platform === "win32" ? ".exe" : "";
  const releaseExe = path.join(
    repoRoot,
    "bpmn-parser",
    "target",
    "release",
    `ogb${exeExt}`,
  );
  const debugExe = path.join(
    repoRoot,
    "bpmn-parser",
    "target",
    "debug",
    `ogb${exeExt}`,
  );

  // Allow explicit override (useful in CI or custom builds)
  const override = process.env.BPMN_PARSER_EXE;
  if (override && fsSync.existsSync(override)) return override;

  if (fsSync.existsSync(releaseExe)) return releaseExe;
  // If release doesn't exist, still require debug to exist.
  return debugExe;
}

// Resolve on each request to avoid stale path after rebuilds.
function getBpmnParserExe() {
  return resolveBpmnParserExe();
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stdout, stderr });
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

app.get("/api/health", async (_req, res) => {
  res.json({ ok: true, bpmnParserExe: getBpmnParserExe() });
});

app.post("/api/generate", async (req, res) => {
  const dsl = typeof req.body?.dsl === "string" ? req.body.dsl : "";
  if (!dsl.trim()) {
    res.status(400).json({ error: "Missing 'dsl' string" });
    return;
  }

  const bpmnParserExe = getBpmnParserExe();
  try {
    // Ensure binary exists
    await fs.access(bpmnParserExe);
  } catch {
    res.status(500).json({
      error:
        "ogb.exe not found. Build it first in bpmn-parser folder (cargo build --release).",
    });
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bpmn-ui-"));
  try {
    const inputPath = path.join(tempDir, "input.txt");
    await fs.writeFile(inputPath, dsl, "utf8");

    // Run generator in temp dir so it writes generated_bpmn.bpmn there.
    await execFileAsync(bpmnParserExe, [inputPath], { cwd: tempDir });

    const outputPath = path.join(tempDir, "generated_bpmn.bpmn");
    const xml = await fs.readFile(outputPath, "utf8");
    res.json({ xml });
  } catch (e) {
    const message =
      (e?.stderr && String(e.stderr)) ||
      (e?.error && String(e.error?.message || e.error)) ||
      String(e);
    res.status(500).json({ error: message });
  } finally {
    // Best-effort cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function convertTextToDsl(text) {
  let t = String(text || "");
  // normalize line endings + trim BOM
  t = t.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!t) return "";

  // If the user already pasted DSL, keep it.
  if (/^\s*=\s+/m.test(t) || /^\s*==\s+/m.test(t) || /^\s*#\s+/m.test(t)) {
    return t;
  }

  // Turn common "one-line process" into lines.
  // Split before known keywords while preserving their text.
  // Also handle when keywords are at the beginning of the line.
  t = t
    .replace(/^\s*Start\b\s*/i, "Start\n")
    .replace(/^\s*#\s*Start\b\s*/i, "# Start\n");

  t = t
    .replace(/\s+(Start)\b/gi, "\n$1")
    .replace(/\s+(Loop:)\b/gi, "\n$1")
    .replace(/\s+(End Loop)\b/gi, "\n$1")
    .replace(/\s+(\.?\s*End)\b/gi, "\n$1")
    .replace(/\bEnd\b\s*$/i, "\nEnd")
    // Do NOT split on "Vendor: text" patterns (e.g. "Unired: регистрация ..."),
    // because that would create a DSL label that requires a trailing `J ...`.
    .replace(/\s+(X\s*->|O\s*->|\+\s*->|\*\s*->)\s*/g, "\n$1")
    .replace(/\s+(J\s+\w+)\b/g, "\n$1")
    .replace(/\s+(X\s*<-|O\s*<-|\+\s*<-|\*\s*<-)\s*/g, "\n$1");

  const rawLines = t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const out = [];
  out.push("= Process");
  out.push("== Main");

  // Collect conditional blocks expanded into DSL sections
  const pendingSections = [];
  let autoId = 1;
  let inLoop = false;

  function slug(prefix) {
    autoId += 1;
    return `${prefix}_${autoId}`;
  }

  function pushIfElseAsGateway(originalLine) {
    // Russian: "если <cond> то <then> иначе <else>"
    // Also supports variants with "иначе:".
    const cleaned = String(originalLine || "")
      .replace(/\s*[.。]\s*$/, "")
      .replace(/\b(End|Конец)\b\.?\s*$/i, "")
      .trim();

    const m = cleaned.match(
      /^\s*если\s+(.+?)\s+то\s+(.+?)(?:\s+иначе[:\s]+(.+))?\s*$/i,
    );
    if (!m) return false;

    const cond1 = m[1].trim();
    const thenText = m[2].trim();
    const elseText = (m[3] || "").trim();

    const thenLabel = slug("then");
    const elseLabel = slug("else");
    const joinLabel = slug("join_after_if");

    if (elseText) {
      out.push(`X ->${thenLabel} "${cond1}" ->${elseLabel} "иначе"`);
    } else {
      out.push(`X ->${thenLabel} "${cond1}" ->${elseLabel} "иначе"`);
    }

    pendingSections.push({
      label: thenLabel,
      lines: [`- ${thenText}`],
      join: joinLabel,
    });
    pendingSections.push({
      label: elseLabel,
      lines: elseText ? [`- ${elseText}`] : [`- (иначе)`],
      join: joinLabel,
    });

    // Ensure join exists after the conditional
    out.push(`J ${joinLabel}`);
    out.push(`X <-${joinLabel}`);
    return true;
  }

  for (const line of rawLines) {
    const l = line.trim();
    if (!l) continue;

    if (/^start\b/i.test(l)) {
      out.push("# Start");
      continue;
    }
    if (/^\.?\s*end\b/i.test(l)) {
      out.push(". End");
      continue;
    }

    // Loop markers
    if (/^Loop:/i.test(l)) {
      // Prefer the DSL loop marker style used by the parser
      out.push(`- ${l}`);
      inLoop = true;
      continue;
    }
    if (/^End Loop$/i.test(l)) {
      out.push("- End Loop");
      inLoop = false;
      continue;
    }

    // Heuristic loop detection for "plain text" inputs.
    // Examples: "Для каждого займа ...", "for each loan ..."
    if (!inLoop && /^(для\s+каждого|for\s+each)\s+/i.test(l)) {
      out.push(`- Loop: ${l}`);
      inLoop = true;

      // If the same line contains an inline conditional, extract and convert it.
      const lower = l.toLowerCase();
      const ifIdx = lower.indexOf("если ");
      if (ifIdx >= 0) {
        const rest = l.slice(ifIdx).replace(/\s+конец\s+цикла.*$/i, "").trim();
        if (rest) {
          pushIfElseAsGateway(rest);
        }
      }

      // If the same line also signals end of loop, close it.
      if (/конец\s+цикла/i.test(l)) {
        out.push("- End Loop");
        inLoop = false;
      }
      continue;
    }
    if (inLoop && /^(конец\s+цикла|end\s+loop)\s*$/i.test(l)) {
      out.push("- End Loop");
      inLoop = false;
      continue;
    }

    // Keep DSL-like lines as-is (labels / gateways / joins)
    if (/^(X|O|\+|\*)\s*(->|<-)/.test(l) || /^J\s+\w+/.test(l) || /^\w[\w-]*:\s*$/.test(l)) {
      // If it's "Label: text" in one line, treat it as a normal step, not a DSL label block.
      const inline = l.match(/^([A-Za-z0-9_-]+):\s+(.+)$/);
      if (inline) {
        out.push(`- ${inline[1]}: ${inline[2]}`);
      } else if (/^\w[\w-]*:\s*$/.test(l)) {
        // A bare label would require a `J ...` block; in plain-text conversion treat it as a step.
        out.push(`- ${l.replace(/:\s*$/, "")}`);
      } else {
        out.push(l);
      }
      continue;
    }

    // Try to detect simple if/else sentences and convert them into gateway + branch sections
    if (pushIfElseAsGateway(l)) {
      continue;
    }

    // Default: treat as a task/step
    out.push(`- ${l}`);
  }

  // Append any auto-generated branch sections (if/else)
  if (pendingSections.length) {
    out.push("");
    for (const sec of pendingSections) {
      out.push(`${sec.label}:`);
      out.push(...sec.lines);
      out.push(`J ${sec.join}`);
      out.push("");
    }
  }

  // Ensure we have a start/end
  if (!out.some((l) => l.startsWith("# "))) {
    out.splice(2, 0, "# Start");
  }
  // Keep only one End (the last one)
  const endIdxs = out
    .map((l, idx) => ({ l, idx }))
    .filter((x) => x.l.startsWith(". "))
    .map((x) => x.idx);
  if (endIdxs.length === 0) {
    out.push(". End");
  } else if (endIdxs.length > 1) {
    const last = endIdxs[endIdxs.length - 1];
    for (let i = endIdxs.length - 2; i >= 0; i--) {
      out.splice(endIdxs[i], 1);
    }
    // ensure the last end stays at the end
    const endLine = out[last - (endIdxs.length - 1)];
    out.splice(out.indexOf(endLine), 1);
    out.push(endLine);
  }

  return out.join("\n");
}

app.post("/api/convert", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) {
    res.status(400).json({ error: "Missing 'text' string" });
    return;
  }
  const dsl = convertTextToDsl(text);
  res.json({ dsl });
});

const port = Number(process.env.PORT || 5175);
app.listen(port, () => {
  console.log(`bpmn-ui server listening on http://localhost:${port}`);
});

