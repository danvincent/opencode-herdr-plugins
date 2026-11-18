import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_IDS,
  isProviderEnabled,
  visibleProviderTabs,
  filterBySource,
  actionProvider,
  isProviderConfigured,
  providerStatus,
  setupHint,
} from "./providers.js";

const noEnv = () => undefined;
const envWithSecrets = (over = {}) => (k) => ({
  ATLASSIAN_EMAIL: "me@example.com",
  ATLASSIAN_API_TOKEN: "sekret-token-123",
  ...over,
}[k]);

describe("settings multi-enable (independent per provider)", () => {
  it("legacy files without trackers default to github+linear only", () => {
    assert.equal(isProviderEnabled({}, "github"), true);
    assert.equal(isProviderEnabled({}, "linear"), true);
    assert.equal(isProviderEnabled({}, "bitbucket"), false);
    assert.equal(isProviderEnabled({}, "jira"), false);
    assert.equal(isProviderEnabled(undefined, "github"), true);
    assert.equal(isProviderEnabled(undefined, "jira"), false);
  });
  it("toggling one provider leaves the others alone", () => {
    const s = {
      github: { enabled: true }, linear: { enabled: true },
      trackers: {
        repositories: ["github", "bitbucket"], issues: ["linear", "jira"],
        bitbucket: { workspace: "acme", enabled: true, baseUrl: "" },
        jira: { baseUrl: "https://x.atlassian.net", enabled: true },
      },
    };
    for (const id of PROVIDER_IDS) assert.equal(isProviderEnabled(s, id), true, id);
    const off = {
      ...s,
      trackers: { ...s.trackers, bitbucket: { ...s.trackers.bitbucket, enabled: false } },
    };
    assert.equal(isProviderEnabled(off, "bitbucket"), false);
    assert.equal(isProviderEnabled(off, "github"), true);
    assert.equal(isProviderEnabled(off, "linear"), true);
    assert.equal(isProviderEnabled(off, "jira"), true);
  });
  it("list membership and the enabled flag are both required", () => {
    const flagOff = { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: false } } };
    assert.equal(isProviderEnabled(flagOff, "bitbucket"), false);
    const listOff = { trackers: { repositories: ["github"], bitbucket: { workspace: "acme", enabled: true } } };
    assert.equal(isProviderEnabled(listOff, "bitbucket"), false);
  });
  it("unknown ids are never enabled", () => {
    assert.equal(isProviderEnabled({}, "mcp"), false);
  });
});

describe("tab visibility matrix (separate tabs, all four concurrently visible)", () => {
  const allOn = {
    github: { enabled: true }, linear: { enabled: true },
    trackers: {
      repositories: ["github", "bitbucket"], issues: ["linear", "jira"],
      bitbucket: { workspace: "acme", enabled: true, baseUrl: "" },
      jira: { baseUrl: "https://x.atlassian.net", enabled: true },
    },
  };
  it("all on shows all four provider tabs when configured", () => {
    assert.deepEqual(visibleProviderTabs(allOn, envWithSecrets()), ["github", "bitbucket", "linear", "jira"]);
  });
  it("legacy settings keep the GitHub/Linear default layout", () => {
    assert.deepEqual(visibleProviderTabs({}, undefined), ["github", "linear"]);
  });
  it("each provider off hides only its tab", () => {
    for (const id of PROVIDER_IDS) {
      const s = JSON.parse(JSON.stringify(allOn));
      if (id === "github") s.github.enabled = false;
      else if (id === "linear") s.linear.enabled = false;
      else if (id === "bitbucket") s.trackers.bitbucket.enabled = false;
      else s.trackers.jira.enabled = false;
      const shown = visibleProviderTabs(s, envWithSecrets());
      assert.ok(!shown.includes(id), `${id} hidden`);
      assert.equal(shown.length, 3);
      for (const other of PROVIDER_IDS) if (other !== id) assert.ok(shown.includes(other), `${other} stays`);
    }
  });
  it("enabled but unconfigured hides its tab (setup hint lives in settings/status, not a tab)", () => {
    const s = {
      github: { enabled: true }, linear: { enabled: true },
      trackers: {
        repositories: ["github", "bitbucket"], issues: ["linear", "jira"],
        bitbucket: { workspace: "", enabled: true, baseUrl: "" },
        jira: { baseUrl: "", enabled: true },
      },
    };
    assert.deepEqual(visibleProviderTabs(s, envWithSecrets()), ["github", "linear"]);
    assert.deepEqual(visibleProviderTabs(s, noEnv), ["github", "linear"]);
  });
  it("unconfigured stays hidden even when enabled; configured shows", () => {
    const s = JSON.parse(JSON.stringify(allOn));
    // bitbucket workspace set but no credentials -> unconfigured -> hidden
    assert.ok(!visibleProviderTabs(s, noEnv).includes("bitbucket"));
    assert.ok(!visibleProviderTabs(s, noEnv).includes("jira"));
    assert.ok(visibleProviderTabs(s, envWithSecrets()).includes("bitbucket"));
    assert.ok(visibleProviderTabs(s, envWithSecrets()).includes("jira"));
  });
});

describe("filtering correctness (provider identity via source field)", () => {
  const items = [
    { source: "github", number: 1 }, { source: "bitbucket", number: 2 },
    { source: "bitbucket", number: 3 }, { source: "github", number: 4 },
    { number: 5 },
  ];
  it("keeps only the requested provider", () => {
    assert.deepEqual(filterBySource(items, "bitbucket").map((p) => p.number), [2, 3]);
    assert.deepEqual(filterBySource(items, "github").map((p) => p.number), [1, 4]);
    assert.deepEqual(filterBySource(items, "jira"), []);
  });
  it("items without a source never match", () => {
    assert.deepEqual(filterBySource(items, undefined), []);
  });
  it("tolerates missing lists", () => {
    assert.deepEqual(filterBySource(undefined, "github"), []);
    assert.deepEqual(filterBySource(null, "github"), []);
  });
});

describe("actions retain origin provider", () => {
  it("actionProvider returns the item source", () => {
    assert.equal(actionProvider({ source: "jira" }), "jira");
    assert.equal(actionProvider({ source: "bitbucket" }), "bitbucket");
    assert.equal(actionProvider({ source: "github" }), "github");
    assert.equal(actionProvider({ source: "linear" }), "linear");
  });
  it("falls back only when the source is missing", () => {
    assert.equal(actionProvider({}, "linear"), "linear");
    assert.equal(actionProvider(null), null);
  });
});

describe("per-provider status strings (no cross-contamination)", () => {
  const on = (id) => id === "github"
    ? { github: { enabled: true } }
    : id === "linear"
      ? { linear: { enabled: true } }
      : id === "bitbucket"
        ? { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true, baseUrl: "" } } }
        : { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://x.atlassian.net", enabled: true } } };
  it("disabled providers report off", () => {
    assert.deepEqual(providerStatus("bitbucket", {}, {}, noEnv), { state: "disabled", text: "Bitbucket: off" });
    assert.deepEqual(providerStatus("jira", {}, {}, noEnv), { state: "disabled", text: "Jira: off" });
  });
  it("enabled but unconfigured reports setup needed", () => {
    const bb = { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "", enabled: true, baseUrl: "" } } };
    assert.deepEqual(providerStatus("bitbucket", bb, {}, noEnv), { state: "unconfigured", text: "Bitbucket: setup needed" });
    const jr = { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "", enabled: true } } };
    assert.deepEqual(providerStatus("jira", jr, { notConfigured: true }, noEnv), { state: "unconfigured", text: "Jira: setup needed" });
  });
  it("running reports checking", () => {
    assert.deepEqual(
      providerStatus("bitbucket", on("bitbucket"), { running: true }, envWithSecrets()),
      { state: "loading", text: "Bitbucket: checking…" },
    );
    assert.deepEqual(
      providerStatus("jira", on("jira"), { running: true }, envWithSecrets()),
      { state: "loading", text: "Jira: checking…" },
    );
  });
  it("a provider error names only that provider", () => {
    const s = providerStatus("bitbucket", on("bitbucket"), { error: "bitbucket answered 401" }, envWithSecrets());
    assert.equal(s.state, "error");
    assert.ok(s.text.startsWith("Bitbucket:"), s.text);
    assert.ok(!s.text.includes("GitHub") && !s.text.includes("Jira"), s.text);
    const j = providerStatus("jira", on("jira"), { error: "jira answered 500" }, envWithSecrets());
    assert.equal(j.state, "error");
    assert.ok(j.text.startsWith("Jira:"), j.text);
    assert.ok(!j.text.includes("Bitbucket"), j.text);
  });
  it("ready reports the provider with its own timestamp", () => {
    const at = Date.now() - 3 * 60_000;
    const s = providerStatus("jira", on("jira"), { at }, envWithSecrets());
    assert.equal(s.state, "ready");
    assert.ok(s.text.startsWith("Jira 3m ago"), s.text);
    assert.ok(!s.text.includes("Bitbucket"), s.text);
  });
  it("ready without a timestamp names the provider", () => {
    assert.deepEqual(providerStatus("bitbucket", on("bitbucket"), {}, envWithSecrets()), { state: "ready", text: "Bitbucket" });
  });
  it("error text never carries secrets", () => {
    const s = providerStatus("jira", on("jira"), { error: "jira answered 401 for me@example.com with Basic c2VrcmV0LXRva2VuLTEyMw==" }, envWithSecrets());
    assert.ok(!s.text.includes("sekret") && !s.text.includes("me@example.com"), s.text);
  });
});

describe("setup guidance (enabled but unconfigured shows a hint, not an empty tab)", () => {
  it("bitbucket hint names settings fields, env vars and the MCP server, without secrets", () => {
    const h = setupHint("bitbucket");
    assert.ok(h.title.length > 0 && h.body.length > 0);
    assert.ok(h.body.includes("ATLASSIAN_EMAIL") && h.body.includes("ATLASSIAN_API_TOKEN"), h.body);
    assert.ok(h.body.includes("bitbucket-mcp"), h.body);
    assert.ok(!h.body.includes("sekret-token-123"), h.body);
  });
  it("jira hint names settings fields, env vars and the read-only MCP tools, without secrets", () => {
    const h = setupHint("jira");
    assert.ok(h.body.includes("ATLASSIAN_EMAIL") && h.body.includes("ATLASSIAN_API_TOKEN"), h.body);
    assert.ok(h.body.includes("atlassian-mcp"), h.body);
    assert.ok(h.body.includes("jira_search") && h.body.includes("jira_get_issue"), h.body);
    assert.ok(h.body.includes("Read only"), h.body);
    assert.ok(!h.body.includes("sekret-token-123"), h.body);
  });
  it("configured checks need credentials and https", () => {
    const bb = { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true, baseUrl: "" } } };
    assert.equal(isProviderConfigured(bb, "bitbucket", noEnv), false);
    assert.equal(isProviderConfigured(bb, "bitbucket", envWithSecrets()), true);
    const jr = { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://x.atlassian.net", enabled: true } } };
    assert.equal(isProviderConfigured(jr, "jira", noEnv), false);
    assert.equal(isProviderConfigured(jr, "jira", envWithSecrets()), true);
  });
});
