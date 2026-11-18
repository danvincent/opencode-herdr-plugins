import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { windowFor, standupSlot, gatherLocal, standupPrompt, STANDUP_TOOLS } from "./local.js";
import { withDefaults, patch } from "./settings.js";

const WIN_TO = { key: "2026-11-17", date: "2026-11-17", label: "Monday", from: new Date("2026-11-17T00:00:00Z").getTime(), to: new Date("2026-11-17T23:59:59Z").getTime() };
const ENV = { ATLASSIAN_EMAIL: "m@e.com", ATLASSIAN_API_TOKEN: "tok123", ATLASSIAN_BASE_URL: "https://example.atlassian.net" };
const getEnv = (k) => ENV[k];

describe("windowFor drives trackers with its exact {from,to} shape", () => {
  it("emits {from,to} (no until) honored by the jira window", async () => {
    const { jiraTracker } = await import("./trackers.js");
    const win = windowFor(new Date(2026, 10, 18, 12, 0, 0));
    assert.ok(typeof win.from === "number" && typeof win.to === "number");
    assert.equal(win.until, undefined);
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    };
    const s = patch(withDefaults({}), { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://example.atlassian.net", enabled: true } } });
    const r = await jiraTracker.listIssues({ fetch, getEnv }, s, win);
    assert.equal(r.status, "ok");
    assert.ok(decodeURIComponent(calls[0]).includes(win.date));
  });
  it("emits {from,to} honored by bitbucket filtering", async () => {
    const { bitbucketTracker } = await import("./trackers.js");
    const win = windowFor(new Date(2026, 10, 18, 12, 0, 0));
    const fetch = async () => ({
      ok: true, status: 200, json: async () => ({
        values: [
          { id: 1, title: "In window", links: { html: { href: "https://bitbucket.org/acme/r/pull-requests/1" } }, state: "OPEN", updated_on: `${win.date}T10:00:00+00:00` },
          { id: 2, title: "Too old", links: { html: { href: "https://bitbucket.org/acme/r/pull-requests/2" } }, state: "OPEN", updated_on: "2020-01-01T00:00:00+00:00" },
        ],
      }),
    });
    const s = patch(withDefaults({}), { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true } } });
    const r = await bitbucketTracker.listPRs({ fetch, getEnv }, s, win);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.prs.map((p) => p.number), [1]);
  });
  it("standupSlot is unchanged and importable from the pure module", () => {
    assert.ok(standupSlot(new Date(2026, 10, 18, 12, 0, 0), [23], true)?.id.endsWith("@23"));
  });
});

describe("gatherLocal propagates tracker errors distinctly from empty", () => {
  const S = () => patch(withDefaults({}), {
    trackers: {
      repositories: ["bitbucket"], issues: ["jira"],
      bitbucket: { workspace: "acme", enabled: true },
      jira: { baseUrl: "https://example.atlassian.net", enabled: true },
    },
  });
  // No repos, no commits, no Slack state, no task summaries: only REST trackers answer.
  const stubDeps = (fetch) => ({
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    readTextFile: async () => { throw new Error("no file"); },
    shared: () => ({}),
    home: () => "/tmp/cc-test-nope",
    appHome: () => "/tmp/cc-test-nope",
    fetch,
    getEnv,
  });
  it("auth failures surface as prErrors/issueErrors, not silent empty", async () => {
    const local = await gatherLocal(WIN_TO, S(), stubDeps(async () => ({ ok: false, status: 401 })));
    assert.deepEqual(local.prs, []);
    assert.deepEqual(local.issues, []);
    assert.equal(local.prErrors.length, 1);
    assert.equal(local.prErrors[0].source, "bitbucket");
    assert.equal(local.prErrors[0].status, "auth-error");
    assert.equal(local.issueErrors.length, 1);
    assert.equal(local.issueErrors[0].source, "jira");
    assert.ok(local.sources && typeof local.sources === "object");
  });
  it("clean empties stay empty with no errors (failure vs empty distinction)", async () => {
    const fetch = async (url) => ({
      ok: true, status: 200, json: async () => (String(url).includes("/search/jql") ? { issues: [], isLast: true } : { values: [] }),
    });
    const local = await gatherLocal(WIN_TO, S(), stubDeps(fetch));
    assert.deepEqual(local.prs, []);
    assert.deepEqual(local.issues, []);
    assert.deepEqual(local.prErrors, []);
    assert.deepEqual(local.issueErrors, []);
    assert.deepEqual(local.sources, { bitbucket: 0, jira: 0 });
  });
  it("keeps the historical local fields alongside the additive error fields", async () => {
    const fetch = async (url) => ({
      ok: true, status: 200, json: async () => (String(url).includes("/search/jql") ? { issues: [], isLast: true } : { values: [] }),
    });
    const local = await gatherLocal(WIN_TO, S(), stubDeps(fetch));
    for (const k of ["commits", "prs", "issues", "tasks", "slack"]) assert.ok(Array.isArray(local[k]), k);
  });
  it("propagates truncation so capped pagination never appears complete", async () => {
    const fetch = async (url) => {
      if (String(url).includes("/search/jql")) return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
      return { ok: true, status: 200, json: async () => ({ next: "https://evil.example/x", values: [{ id: 1, title: "P", links: { html: { href: "https://bitbucket.org/acme/r/pull-requests/1" } }, state: "OPEN", updated_on: "2026-11-17T10:00:00+00:00" }] }) };
    };
    const local = await gatherLocal(WIN_TO, S(), stubDeps(fetch));
    assert.equal(local.prTruncated, true);
    assert.equal(local.issueTruncated ?? false, false);
    assert.equal(local.truncated, true);
    assert.deepEqual(local.truncatedSources, { bitbucket: true });
    const p = standupPrompt(WIN_TO, local);
    assert.ok(/truncat/i.test(p), "prompt must surface truncation");
    assert.ok(p.includes("bitbucket"));
  });
  it("reports no truncation on clean empties (backward compatible defaults)", async () => {
    const fetch = async (url) => ({
      ok: true, status: 200, json: async () => (String(url).includes("/search/jql") ? { issues: [], isLast: true } : { values: [] }),
    });
    const local = await gatherLocal(WIN_TO, S(), stubDeps(fetch));
    assert.equal(local.prTruncated ?? false, false);
    assert.equal(local.issueTruncated ?? false, false);
    assert.equal(local.truncated ?? false, false);
    assert.deepEqual(local.truncatedSources ?? {}, {});
  });
});

describe("standupPrompt surfaces tracker gaps instead of silently showing (none)", () => {
  it("names failed trackers with their status", () => {
    const local = {
      commits: [], prs: [], issues: [], tasks: [], slack: [],
      prErrors: [{ source: "bitbucket", status: "auth-error", error: "bitbucket answered 401" }],
      issueErrors: [],
      sources: {},
    };
    const p = standupPrompt(WIN_TO, local);
    assert.ok(p.includes("bitbucket"));
    assert.ok(p.includes("401"));
    assert.ok(/gap/i.test(p));
  });
  it("omits the gaps section when everything succeeded", () => {
    const p = standupPrompt(WIN_TO, { commits: [], prs: [], issues: [], tasks: [], slack: [], prErrors: [], issueErrors: [], sources: {} });
    assert.ok(!/tracker gaps/i.test(p));
  });
  it("tolerates locals without the additive fields (backward compatible)", () => {
    const p = standupPrompt(WIN_TO, { commits: [], prs: [], issues: [], tasks: [], slack: [] });
    assert.ok(p.includes("What did you accomplish?"));
  });
});

describe("STANDUP_TOOLS is read-only", () => {
  it("excludes jira write tools but keeps jira search/get", () => {
    assert.ok(!STANDUP_TOOLS.includes("mcp__atlassian-mcp__jira_transition_issue"));
    assert.ok(!STANDUP_TOOLS.includes("mcp__atlassian-mcp__jira_add_comment"));
    assert.ok(STANDUP_TOOLS.includes("mcp__atlassian-mcp__jira_search"));
    assert.ok(STANDUP_TOOLS.includes("mcp__atlassian-mcp__jira_get_issue"));
    assert.equal(STANDUP_TOOLS[0], "ToolSearch");
  });
});
