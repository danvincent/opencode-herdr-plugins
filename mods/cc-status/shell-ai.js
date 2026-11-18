// Loosely coupled shell AI adapter: Claude Code by default, OpenCode when selected.
//
// The Claude invocation is byte-for-byte the historical one. OpenCode uses only the
// verified `opencode run <prompt>` shape: no JSON/format flags and no model or tool
// flags, which are unverified for that CLI, so per-call model/budget/tools are ignored
// on the OpenCode path. The adapter is dependency-injected (exec/home/appHome come
// from the caller) so it stays decoupled from Herdr and testable under plain node.

export const AI_PROVIDERS = ["claude", "opencode"];

// Unknown or missing selections fall back to Claude, preserving current behavior.
export function resolveProvider(settings) {
  return settings?.ai?.provider === "opencode" ? "opencode" : "claude";
}

// The exact historical Claude invocation; kept here so tests pin it.
export function claudeArgs(prompt, tools, model, budget, extra) {
  return [
    "-p", prompt,
    "--model", model,
    "--tools", "ToolSearch",
    "--allowedTools", tools.join(","),
    "--output-format", "json",
    "--no-session-persistence",
    "--max-budget-usd", budget,
    ...extra,
  ];
}

// Only the verified shape: `opencode run <prompt>`.
export function opencodeArgs(prompt) {
  return ["run", prompt];
}

// Strict JSON-only instruction for OpenCode schema requests. Claude keeps its
// --json-schema flags and structured schemas unchanged; OpenCode has no such
// flags, so the schema is inlined into the prompt and the reply must be plain JSON.
export const OPENCODE_JSON_SUFFIX =
  "Reply with ONLY a single JSON object, no markdown, no code fences, no other text.";

export function opencodePrompt(prompt, extra = []) {
  const i = extra.indexOf("--json-schema");
  const schema = i >= 0 ? extra[i + 1] : null;
  if (!schema) return prompt;
  return `${prompt}\n\n${OPENCODE_JSON_SUFFIX}\nIt must match this JSON Schema:\n${schema}`;
}

// First/whole JSON object in plain stdout: whole-stdout JSON first, then the
// first balanced `{...}` span (covers prose and fenced replies with trailing text).
export function parseJsonObject(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch { /* fall through to extraction */ }
  for (let start = trimmed.indexOf("{"); start >= 0; start = trimmed.indexOf("{", start + 1)) {
    const end = matchBrace(trimmed, start);
    if (end < 0) continue;
    try {
      const v = JSON.parse(trimmed.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch { /* try the next `{` */ }
  }
  return null;
}

// Index of the `}` balancing trimmed[start] (`{`), skipping strings/escapes; -1 when unbalanced.
function matchBrace(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Success needs a clean exit, no provider error, and nonempty text.
export function isSuccess(r) {
  return r?.code === 0 && !r?.isError && Boolean((r?.text ?? "").trim());
}

// Claude Code's needs-auth cache is Claude-only: OpenCode never checks it,
// and forced (user-asked) runs never check it either.
export function shouldCheckAuth(settings, forced = false) {
  if (forced) return false;
  return resolveProvider(settings) === "claude";
}

// Provider-neutral result: { provider, code, stdout, stderr, text, structured, cost, isError }.
// Claude fills every field from its JSON envelope; OpenCode parses plain stdout
// for a JSON object (structured) and reads text from it when present.
export function normalizeResult(provider, raw) {
  const code = raw?.code ?? 1;
  const stdout = raw?.stdout ?? "";
  const stderr = raw?.stderr ?? "";
  if (provider === "opencode") {
    const structured = parseJsonObject(stdout);
    let text = stdout.trim();
    if (structured) {
      if (typeof structured.text === "string" && structured.text) text = structured.text;
      else if (typeof structured.result === "string" && structured.result) text = structured.result;
      else if (Array.isArray(structured.bullets)) text = structured.bullets.join("\n");
    }
    return { provider, code, stdout, stderr, text, structured, cost: null, isError: code !== 0 };
  }
  let out = {};
  try {
    out = JSON.parse(stdout || "{}");
  } catch {
    out = {};
  }
  return {
    provider,
    code,
    stdout,
    stderr,
    text: out.result ?? "",
    structured: out.structured_output ?? null,
    cost: out.total_cost_usd ?? null,
    isError: out.is_error === true,
  };
}

// Dispatches one headless run and returns the normalized result.
export async function runShellAi(deps, settings, { prompt, tools, extra = [], timeout, model = "haiku", budget = "0.5" }) {
  const provider = resolveProvider(settings);
  const { exec, home, appHome } = deps;
  const dir = `${appHome()}/data/cc-claude`;
  await exec("mkdir", ["-p", dir]);
  if (provider === "opencode") {
    const raw = await exec("opencode", opencodeArgs(opencodePrompt(prompt, extra)), { cwd: dir, timeout });
    return normalizeResult(provider, raw);
  }
  const raw = await exec(`${home()}/.local/bin/claude`, claudeArgs(prompt, tools, model, budget, extra), { cwd: dir, timeout });
  return normalizeResult(provider, raw);
}
