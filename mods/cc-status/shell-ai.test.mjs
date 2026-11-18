import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AI_PROVIDERS,
  resolveProvider,
  claudeArgs,
  opencodeArgs,
  opencodePrompt,
  parseJsonObject,
  normalizeResult,
  isSuccess,
  shouldCheckAuth,
  runShellAi,
} from "./shell-ai.js";
import { DEFAULTS, withDefaults } from "./settings.js";

const PROMPT = "list my issues";
const TOOLS = ["ToolSearch", "mcp__claude_ai_Linear__list_issues"];

describe("resolveProvider", () => {
  it("defaults to claude when settings are missing or partial", () => {
    assert.equal(resolveProvider(undefined), "claude");
    assert.equal(resolveProvider({}), "claude");
    assert.equal(resolveProvider({ ai: {} }), "claude");
  });
  it("falls back to claude for unknown providers", () => {
    assert.equal(resolveProvider({ ai: { provider: "bogus" } }), "claude");
  });
  it("selects opencode when set", () => {
    assert.equal(resolveProvider({ ai: { provider: "opencode" } }), "opencode");
  });
});

describe("claudeArgs", () => {
  it("keeps the exact historical Claude invocation", () => {
    assert.deepEqual(claudeArgs(PROMPT, TOOLS, "haiku", "0.5", ["--json-schema", "{}"]), [
      "-p", PROMPT,
      "--model", "haiku",
      "--tools", "ToolSearch",
      "--allowedTools", TOOLS.join(","),
      "--output-format", "json",
      "--no-session-persistence",
      "--max-budget-usd", "0.5",
      "--json-schema", "{}",
    ]);
  });
});

describe("opencodeArgs", () => {
  it("uses only the verified `opencode run <prompt>` shape", () => {
    assert.deepEqual(opencodeArgs(PROMPT), ["run", PROMPT]);
  });
  it("passes no model, tool or format flags", () => {
    const args = opencodeArgs(PROMPT);
    assert.equal(args.length, 2);
    assert.ok(!args.join(" ").includes("--"));
  });
});

describe("normalizeResult", () => {
  it("parses the claude JSON envelope", () => {
    const out = { result: "hello", structured_output: { a: 1 }, total_cost_usd: 0.01, is_error: false };
    const r = normalizeResult("claude", { code: 0, stdout: JSON.stringify(out), stderr: "" });
    assert.equal(r.provider, "claude");
    assert.equal(r.text, "hello");
    assert.deepEqual(r.structured, { a: 1 });
    assert.equal(r.cost, 0.01);
    assert.equal(r.isError, false);
  });
  it("tolerates claude stdout that is not JSON", () => {
    const r = normalizeResult("claude", { code: 1, stdout: "boom", stderr: "bad" });
    assert.equal(r.text, "");
    assert.equal(r.structured, null);
    assert.equal(r.cost, null);
  });
  it("wraps opencode plain text without inventing structure", () => {
    const r = normalizeResult("opencode", { code: 0, stdout: "  done it\n", stderr: "" });
    assert.equal(r.provider, "opencode");
    assert.equal(r.text, "done it");
    assert.equal(r.structured, null);
    assert.equal(r.cost, null);
    assert.equal(r.isError, false);
  });
  it("parses opencode whole-stdout JSON into structured", () => {
    const structured = { items: [], resolved: [], error: "", connected: true };
    const r = normalizeResult("opencode", { code: 0, stdout: JSON.stringify(structured), stderr: "" });
    assert.deepEqual(r.structured, structured);
    assert.equal(r.isError, false);
  });
  it("parses opencode JSON wrapped in prose or fences", () => {
    const structured = { text: "- did a thing", error: "" };
    const stdout = `Here is the result:\n\`\`\`json\n${JSON.stringify(structured)}\n\`\`\`\n`;
    const r = normalizeResult("opencode", { code: 0, stdout, stderr: "" });
    assert.deepEqual(r.structured, structured);
    assert.equal(r.text, "- did a thing");
  });
  it("parses opencode first JSON object when surrounded by text", () => {
    const first = { bullets: ["a", "b"] };
    const stdout = `prefix ${JSON.stringify(first)} trailing {"other":1}`;
    const r = normalizeResult("opencode", { code: 0, stdout, stderr: "" });
    assert.deepEqual(r.structured, first);
  });
  it("marks opencode failures via code even with JSON body", () => {
    const r = normalizeResult("opencode", { code: 1, stdout: JSON.stringify({ error: "x" }), stderr: "bad" });
    assert.equal(r.isError, true);
  });
});

describe("parseJsonObject", () => {
  it("returns null for plain text", () => {
    assert.equal(parseJsonObject("just a sentence"), null);
    assert.equal(parseJsonObject(""), null);
    assert.equal(parseJsonObject(null), null);
  });
  it("parses whole JSON objects", () => {
    assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  });
});

describe("opencodePrompt", () => {
  it("leaves plain prompts without a schema alone", () => {
    assert.equal(opencodePrompt(PROMPT, []), PROMPT);
  });
  it("appends a strict JSON-only instruction when a schema is requested", () => {
    const out = opencodePrompt(PROMPT, ["--json-schema", '{"type":"object"}']);
    assert.ok(out.startsWith(PROMPT));
    assert.ok(/only.*json object/i.test(out));
    assert.ok(out.includes('{"type":"object"}'));
  });
});

describe("isSuccess", () => {
  it("requires code 0, no isError, and nonempty text", () => {
    assert.equal(isSuccess({ code: 0, isError: false, text: "moved" }), true);
    assert.equal(isSuccess({ code: 0, isError: false, text: "  \n " }), false);
    assert.equal(isSuccess({ code: 0, isError: false, text: "" }), false);
    assert.equal(isSuccess({ code: 1, isError: false, text: "moved" }), false);
    assert.equal(isSuccess({ code: 0, isError: true, text: "moved" }), false);
  });
});

describe("shouldCheckAuth", () => {
  it("is Claude-only and skippable when forced", () => {
    assert.equal(shouldCheckAuth({ ai: { provider: "claude" } }, false), true);
    assert.equal(shouldCheckAuth({ ai: { provider: "opencode" } }, false), false);
    assert.equal(shouldCheckAuth({ ai: { provider: "claude" } }, true), false);
    assert.equal(shouldCheckAuth({}, false), true);
  });
});

describe("runShellAi", () => {
  const deps = (seen) => ({
    home: () => "/home/u",
    appHome: () => "/tmp/cc-test-home",
    exec: async (cmd, args, opts) => {
      seen.push({ cmd, args, opts });
      if (cmd === "mkdir") return { code: 0, stdout: "", stderr: "" };
      if (cmd.endsWith("/claude")) {
        return { code: 0, stdout: JSON.stringify({ result: "r", structured_output: { x: 1 }, total_cost_usd: 0.02 }), stderr: "" };
      }
      return { code: 0, stdout: "ok text", stderr: "" };
    },
  });

  it("runs claude by default with the exact invocation in the work dir", async () => {
    const seen = [];
    const r = await runShellAi(deps(seen), {}, {
      prompt: PROMPT, tools: TOOLS, extra: ["--json-schema", "{}"], timeout: 1000, model: "haiku", budget: "0.5",
    });
    const call = seen.find((c) => c.cmd !== "mkdir");
    assert.equal(call.cmd, "/home/u/.local/bin/claude");
    assert.deepEqual(call.args, claudeArgs(PROMPT, TOOLS, "haiku", "0.5", ["--json-schema", "{}"]));
    assert.equal(call.opts.cwd, "/tmp/cc-test-home/data/cc-claude");
    assert.equal(r.provider, "claude");
    assert.equal(r.text, "r");
    assert.deepEqual(r.structured, { x: 1 });
    assert.equal(r.cost, 0.02);
  });

  it("runs `opencode run <prompt>` when selected, ignoring claude-only flags", async () => {
    const seen = [];
    const r = await runShellAi(deps(seen), { ai: { provider: "opencode" } }, {
      prompt: PROMPT, tools: TOOLS, extra: [], timeout: 1000, model: "sonnet", budget: "1",
    });
    const call = seen.find((c) => c.cmd !== "mkdir");
    assert.equal(call.cmd, "opencode");
    assert.deepEqual(call.args, ["run", PROMPT]);
    assert.equal(r.provider, "opencode");
    assert.equal(r.text, "ok text");
    assert.equal(r.structured, null);
  });
  it("adapts opencode prompts with a JSON-only instruction for schema requests", async () => {
    const seen = [];
    const extra = ["--json-schema", '{"type":"object"}'];
    const r = await runShellAi(deps(seen), { ai: { provider: "opencode" } }, {
      prompt: PROMPT, tools: TOOLS, extra, timeout: 1000, model: "sonnet", budget: "1",
    });
    const call = seen.find((c) => c.cmd !== "mkdir");
    assert.equal(call.cmd, "opencode");
    assert.deepEqual(call.args, ["run", opencodePrompt(PROMPT, extra)]);
    assert.ok(call.args[1].length > PROMPT.length);
    assert.equal(r.provider, "opencode");
  });
  it("parses structured JSON from opencode stdout", async () => {
    const structured = { text: "- did it", error: "" };
    const seen = [];
    const localDeps = {
      home: () => "/home/u",
      appHome: () => "/tmp/cc-test-home",
      exec: async (cmd) => {
        if (cmd === "mkdir") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: `\`\`\`json\n${JSON.stringify(structured)}\n\`\`\``, stderr: "" };
      },
    };
    const r = await runShellAi(localDeps, { ai: { provider: "opencode" } }, {
      prompt: PROMPT, tools: TOOLS, extra: ["--json-schema", "{}"], timeout: 1000,
    });
    assert.deepEqual(r.structured, structured);
    assert.equal(r.text, "- did it");
  });
});

describe("settings", () => {
  it("defaults the AI provider to claude", () => {
    assert.ok(AI_PROVIDERS.includes("claude"));
    assert.ok(AI_PROVIDERS.includes("opencode"));
    assert.equal(DEFAULTS.ai.provider, "claude");
    assert.equal(withDefaults({}).ai.provider, "claude");
  });
  it("keeps an opencode selection through withDefaults", () => {
    assert.equal(withDefaults({ ai: { provider: "opencode" } }).ai.provider, "opencode");
  });
});
