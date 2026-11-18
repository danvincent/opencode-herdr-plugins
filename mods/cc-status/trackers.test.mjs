import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRACKER_IDS,
  DEFAULT_REPOSITORIES,
  DEFAULT_ISSUES,
  getRepositoryIds,
  getIssueIds,
  isTrackerEnabled,
  githubTracker,
  bitbucketTracker,
  linearTracker,
  jiraTracker,
  normalizeGithubPR,
  normalizeBitbucketPR,
  normalizeJiraIssue,
  mergePRs,
  mergeIssues,
  sanitizeError,
  formatPRsForPrompt,
  formatIssuesForPrompt,
  listAllPRs,
  listAllIssues,
  JIRA_MCP_SERVER,
  JIRA_MCP_TOOLS,
  JIRA_MCP_READ,
  JIRA_MCP_WRITE,
  BITBUCKET_MCP_SERVER,
  BITBUCKET_MCP_TOOLS,
  mcpToolsFor,
  jiraWindowJql,
  jiraMcpPrompt,
  bitbucketMcpPrompt,
  isSecureBase,
} from "./trackers.js";
import { DEFAULTS, withDefaults, patch } from "./settings.js";

const WIN = { from: new Date("2026-11-17T00:00:00Z").getTime(), until: new Date("2026-11-17T23:59:59Z").getTime(), date: "2026-11-17" };
const ENV_FULL = { ATLASSIAN_EMAIL: "me@example.com", ATLASSIAN_API_TOKEN: "tok123", ATLASSIAN_BASE_URL: "https://example.atlassian.net" };
const getEnvFull = (k) => ENV_FULL[k];
const getEnvEmpty = () => undefined;

describe("tracker registry", () => {
  it("exposes the four pluggable tracker ids", () => {
    assert.deepEqual([...TRACKER_IDS].sort(), ["bitbucket", "github", "jira", "linear"]);
    assert.equal(githubTracker.id, "github");
    assert.equal(githubTracker.kind, "repository");
    assert.equal(bitbucketTracker.id, "bitbucket");
    assert.equal(bitbucketTracker.kind, "repository");
    assert.equal(linearTracker.id, "linear");
    assert.equal(linearTracker.kind, "issues");
    assert.equal(jiraTracker.id, "jira");
    assert.equal(jiraTracker.kind, "issues");
  });
  it("defaults to github+linear only", () => {
    assert.deepEqual(DEFAULT_REPOSITORIES, ["github"]);
    assert.deepEqual(DEFAULT_ISSUES, ["linear"]);
    assert.deepEqual(getRepositoryIds(withDefaults({})), ["github"]);
    assert.deepEqual(getIssueIds(withDefaults({})), ["linear"]);
    assert.ok(DEFAULTS.trackers.repositories.includes("github"));
    assert.ok(DEFAULTS.trackers.issues.includes("linear"));
  });
  it("withDefaults/patch keep tracker sub-defaults backward compatible", () => {
    const s = withDefaults({});
    assert.equal(typeof s.trackers.bitbucket.workspace, "string");
    assert.equal(typeof s.trackers.jira.baseUrl, "string");
    const p = patch(s, { trackers: { bitbucket: { workspace: "acme" } } });
    assert.deepEqual(p.trackers.repositories, ["github"]);
    assert.equal(p.trackers.bitbucket.workspace, "acme");
  });
});

describe("isConfigured vs skipped", () => {
  it("github is configured by default", () => {
    assert.equal(githubTracker.isConfigured(withDefaults({})), true);
  });
  it("bitbucket is not configured without workspace or credentials", () => {
    const s = withDefaults({});
    assert.equal(bitbucketTracker.isConfigured(s, getEnvEmpty), false);
    assert.equal(bitbucketTracker.isConfigured(s, getEnvFull), false);
    const s2 = patch(s, { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true } } });
    assert.equal(bitbucketTracker.isConfigured(s2, getEnvEmpty), false);
    assert.equal(bitbucketTracker.isConfigured(s2, getEnvFull), true);
  });
  it("jira is not configured without baseUrl or credentials", () => {
    const s = withDefaults({});
    assert.equal(jiraTracker.isConfigured(s, getEnvEmpty), false);
    const s2 = patch(s, { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://example.atlassian.net", enabled: true } } });
    assert.equal(jiraTracker.isConfigured(s2, getEnvEmpty), false);
    assert.equal(jiraTracker.isConfigured(s2, getEnvFull), true);
  });
  it("linear is configured when enabled", () => {
    assert.equal(linearTracker.isConfigured(withDefaults({})), true);
    assert.equal(linearTracker.isConfigured(withDefaults({ linear: { enabled: false } })), false);
  });
  it("isTrackerEnabled respects lists and enabled flags", () => {
    const s = withDefaults({});
    assert.equal(isTrackerEnabled(s, "github"), true);
    assert.equal(isTrackerEnabled(s, "bitbucket"), false);
    assert.equal(isTrackerEnabled(s, "linear"), true);
    assert.equal(isTrackerEnabled(s, "jira"), false);
  });
});

describe("normalization", () => {
  it("normalizes a github search pr", () => {
    const p = normalizeGithubPR({ number: 12, title: "Fix it", url: "https://github.com/o/r/pull/12", repository: { name: "r", nameWithOwner: "o/r" }, state: "OPEN", isDraft: false });
    assert.deepEqual(p, { source: "github", number: 12, title: "Fix it", url: "https://github.com/o/r/pull/12", state: "open", draft: false, repo: "o/r" });
  });
  it("normalizes a bitbucket pr", () => {
    const p = normalizeBitbucketPR({ id: 7, title: "BB fix", links: { html: { href: "https://bitbucket.org/acme/r/pull-requests/7" } }, state: "OPEN", draft: false, updated_on: "2026-11-17T10:00:00+00:00" }, "acme/r");
    assert.equal(p.source, "bitbucket");
    assert.equal(p.number, 7);
    assert.equal(p.repo, "acme/r");
    assert.equal(p.url, "https://bitbucket.org/acme/r/pull-requests/7");
  });
  it("normalizes a jira issue", () => {
    const j = normalizeJiraIssue({ key: "ENG-1", fields: { summary: "Do thing", status: { name: "In Progress" }, updated: "2026-11-17T10:00:00.000+0000" } }, "https://example.atlassian.net");
    assert.deepEqual(j, { source: "jira", key: "ENG-1", identifier: "ENG-1", title: "Do thing", url: "https://example.atlassian.net/browse/ENG-1", state: "In Progress", updated: "2026-11-17T10:00:00.000+0000" });
  });
  it("mergePRs dedups across trackers by source+repo+number", () => {
    const a = { source: "github", number: 1, title: "A", url: "u1", state: "open", draft: false, repo: "o/r" };
    const b = { source: "github", number: 1, title: "A dup", url: "u1", state: "open", draft: false, repo: "o/r" };
    const c = { source: "bitbucket", number: 1, title: "BB", url: "u2", state: "open", draft: false, repo: "acme/r" };
    assert.deepEqual(mergePRs([a, b], [c]).length, 2);
  });
  it("mergeIssues dedups by source+key", () => {
    const a = { source: "jira", key: "ENG-1", identifier: "ENG-1", title: "A", url: "u", state: "Todo" };
    const b = { source: "jira", key: "ENG-1", identifier: "ENG-1", title: "A dup", url: "u", state: "Todo" };
    assert.deepEqual(mergeIssues([a], [b]).length, 1);
  });
  it("sanitizeError never leaks credentials", () => {
    const msg = sanitizeError(new Error("auth tok123 me@example.com Basic bWU6dG9r failed"));
    assert.ok(!msg.includes("tok123"));
    assert.ok(!msg.includes("me@example.com"));
    assert.ok(!msg.toLowerCase().includes("basic bwu"));
  });
});

describe("github listPRs wraps gh flags without change", () => {
  it("uses the exact historical gh search flags", async () => {
    const seen = [];
    const exec = async (cmd, args) => {
      seen.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify([{ number: 3, title: "T", url: "U", repository: { name: "r", nameWithOwner: "o/r" }, state: "OPEN", isDraft: false }]) };
    };
    const r = await githubTracker.listPRs({ exec }, WIN);
    assert.equal(r.status, "ok");
    assert.equal(r.prs.length, 1);
    const call = seen.find((c) => c.cmd === "gh");
    assert.deepEqual(call.args, ["search", "prs", "--author=@me", `--updated=${WIN.date}..${WIN.date}`, "--json", "number,title,url,repository,state,isDraft", "--limit", "30"]);
  });
  it("tolerates malformed gh JSON as empty, not error", async () => {
    const exec = async () => ({ code: 0, stdout: "not json{{{" });
    const r = await githubTracker.listPRs({ exec }, WIN);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.prs, []);
  });
  it("maps gh failure to empty with no throw", async () => {
    const exec = async () => { throw new Error("gh missing"); };
    const r = await githubTracker.listPRs({ exec }, WIN);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.prs, []);
  });
});

describe("bitbucket pagination + windows + auth", () => {
  const settings = () => patch(withDefaults({}), { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true } } });
  const pr = (id, updated_on) => ({ id, title: `PR ${id}`, links: { html: { href: `https://bitbucket.org/acme/r/pull-requests/${id}` } }, state: "OPEN", updated_on });
  it("follows next links and filters to the window", async () => {
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      assert.ok(url.includes("pagelen=50"), "pagelen 50 required");
      assert.ok(url.includes("q="), "q filter required");
      if (url.includes("page=2")) return { ok: true, status: 200, json: async () => ({ values: [pr(3, "2026-11-10T00:00:00+00:00")] }) };
      return { ok: true, status: 200, json: async () => ({ next: "https://api.bitbucket.org/2.0/x?pagelen=50&q=updated_on&page=2", values: [pr(1, "2026-11-17T10:00:00+00:00"), pr(2, "2026-11-17T11:00:00+00:00")] }) };
    };
    const r = await bitbucketTracker.listPRs({ fetch, getEnv: getEnvFull }, settings(), WIN);
    assert.equal(r.status, "ok");
    assert.equal(r.prs.length, 2);
    assert.ok(calls.length >= 2, "must follow next");
  });
  it("returns skipped when not configured", async () => {
    let called = false;
    const fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({ values: [] }) }; };
    const r = await bitbucketTracker.listPRs({ fetch, getEnv: getEnvEmpty }, withDefaults({}), WIN);
    assert.equal(r.status, "skipped");
    assert.equal(called, false);
  });
  it("maps 401 to auth-error without leaking the token", async () => {
    const fetch = async () => ({ ok: false, status: 401, text: async () => "Bad credentials" });
    const r = await bitbucketTracker.listPRs({ fetch, getEnv: getEnvFull }, settings(), WIN);
    assert.equal(r.status, "auth-error");
    assert.ok(!(r.error ?? "").includes("tok123"));
  });
  it("tolerates malformed JSON as error, not throw", async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } });
    const r = await bitbucketTracker.listPRs({ fetch, getEnv: getEnvFull }, settings(), WIN);
    assert.equal(r.status, "error");
    assert.deepEqual(r.prs, []);
  });
});

describe("jira pagination + JQL + auth", () => {
  const settings = () => patch(withDefaults({}), { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://example.atlassian.net", enabled: true } } });
  it("sends window-aware JQL with required fields and follows pagination", async () => {
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      assert.ok(url.includes("/rest/api/3/search/jql"), "must use /rest/api/3/search/jql");
      assert.ok(url.includes("fields="), "must request fields");
      if (url.includes("nextPageToken=tok")) return { ok: true, status: 200, json: async () => ({ issues: [{ key: "ENG-2", fields: { summary: "B", status: { name: "Done" }, updated: "2026-11-17T12:00:00.000+0000" } }], isLast: true }) };
      return { ok: true, status: 200, json: async () => ({ issues: [{ key: "ENG-1", fields: { summary: "A", status: { name: "In Progress" }, updated: "2026-11-17T10:00:00.000+0000" } }], isLast: false, nextPageToken: "tok" }) };
    };
    const r = await jiraTracker.listIssues({ fetch, getEnv: getEnvFull }, settings(), WIN);
    assert.equal(r.status, "ok");
    assert.equal(r.issues.length, 2);
    assert.ok(decodeURIComponent(calls[0]).includes("assignee = currentUser()"));
    assert.ok(decodeURIComponent(calls[0]).includes("updated"));
    assert.ok(calls.length >= 2);
  });
  it("returns skipped when not configured", async () => {
    let called = false;
    const fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({ issues: [] }) }; };
    const r = await jiraTracker.listIssues({ fetch, getEnv: getEnvEmpty }, withDefaults({}), WIN);
    assert.equal(r.status, "skipped");
    assert.equal(called, false);
  });
  it("maps 401/403 to auth-error without leaking credentials", async () => {
    const fetch = async () => ({ ok: false, status: 403, text: async () => "forbidden" });
    const r = await jiraTracker.listIssues({ fetch, getEnv: getEnvFull }, settings(), WIN);
    assert.equal(r.status, "auth-error");
    assert.ok(!(r.error ?? "").includes("tok123"));
  });
  it("tolerates malformed JSON as error, not throw", async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } });
    const r = await jiraTracker.listIssues({ fetch, getEnv: getEnvFull }, settings(), WIN);
    assert.equal(r.status, "error");
    assert.deepEqual(r.issues, []);
  });
});

describe("multi-tracker merge/dedup dispatch", () => {
  it("merges github+bitbucket concurrently, skips unconfigured", async () => {
    const s = patch(withDefaults({}), { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "", enabled: false } } });
    const exec = async () => ({ code: 0, stdout: JSON.stringify([{ number: 1, title: "G", url: "u", repository: { nameWithOwner: "o/r" }, state: "OPEN", isDraft: false }]) });
    const r = await listAllPRs({ exec, fetch: async () => { throw new Error("must not fetch when skipped"); }, getEnv: getEnvEmpty }, s, WIN);
    assert.ok(r.prs.length >= 1);
    assert.deepEqual(r.sources, { github: 1 });
    assert.deepEqual(r.errors, []);
  });
  it("merges jira issues with empty-vs-auth-failure distinction", async () => {
    const s = patch(withDefaults({}), { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://example.atlassian.net", enabled: true } } });
    const fetch = async () => ({ ok: false, status: 401, text: async () => "nope" });
    const r = await listAllIssues({ fetch, getEnv: getEnvFull }, s, WIN);
    assert.equal(r.issues.length, 0);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].source, "jira");
    assert.equal(r.errors[0].status, "auth-error");
  });
  it("preserves per-tracker truncated in aggregated PRs (foreign-origin cap)", async () => {
    const s = patch(withDefaults({}), { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true } } });
    const fetch = async (url) => {
      if (String(url).includes("evil.example")) throw new Error("must not fetch foreign origin");
      return { ok: true, status: 200, json: async () => ({ next: "https://evil.example/x", values: [{ id: 1, title: "P", links: { html: { href: "https://bitbucket.org/acme/r/pull-requests/1" } }, state: "OPEN", updated_on: "2026-11-17T10:00:00+00:00" }] }) };
    };
    const noExec = async () => ({ code: 0, stdout: "[]" });
    const r = await listAllPRs({ exec: noExec, fetch, getEnv: getEnvFull }, s, WIN);
    assert.equal(r.prs.length, 1);
    assert.equal(r.truncated, true);
    assert.deepEqual(r.truncatedSources, { bitbucket: true });
  });
  it("preserves per-tracker truncated in aggregated issues (no cap stays false)", async () => {
    const s = patch(withDefaults({}), { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://example.atlassian.net", enabled: true } } });
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) });
    const r = await listAllIssues({ fetch, getEnv: getEnvFull }, s, WIN);
    assert.equal(r.truncated ?? false, false);
    assert.deepEqual(r.truncatedSources ?? {}, {});
  });
});

describe("prompt formatting", () => {
  it("formats PRs and issues as prompt lines", () => {
    const prs = [{ source: "github", number: 1, title: "T", url: "U", state: "open", draft: false, repo: "o/r" }];
    assert.ok(formatPRsForPrompt(prs)[0].includes("o/r #1"));
    const issues = [{ source: "jira", key: "ENG-1", identifier: "ENG-1", title: "Do", url: "https://x/browse/ENG-1", state: "Todo" }];
    assert.ok(formatIssuesForPrompt(issues)[0].includes("ENG-1"));
  });
});

describe("MCP tool selection (MCP-first, REST fallback)", () => {
  it("exposes the Jira MCP server with search-first tools", () => {
    assert.equal(JIRA_MCP_SERVER, "atlassian-mcp");
    assert.ok(Array.isArray(JIRA_MCP_TOOLS));
    assert.equal(JIRA_MCP_TOOLS[0], "ToolSearch");
    assert.ok(JIRA_MCP_TOOLS.includes("mcp__atlassian-mcp__jira_search"));
    assert.ok(JIRA_MCP_TOOLS.includes("mcp__atlassian-mcp__jira_get_issue"));
  });
  it("exposes the separate Bitbucket MCP server with PR tools", () => {
    assert.equal(BITBUCKET_MCP_SERVER, "bitbucket-mcp");
    assert.ok(Array.isArray(BITBUCKET_MCP_TOOLS));
    assert.equal(BITBUCKET_MCP_TOOLS[0], "ToolSearch");
    assert.ok(BITBUCKET_MCP_TOOLS.some((t) => t.includes("list_pull_requests") || t.includes("get_pull_requests")));
    assert.ok(BITBUCKET_MCP_TOOLS.some((t) => t.includes("get_pull_request")));
  });
  it("Jira MCP tools stay Jira+Confluence only (no Bitbucket PR tools)", () => {
    for (const t of JIRA_MCP_TOOLS) assert.ok(!t.includes("pull_request"), `jira tool must not be a PR tool: ${t}`);
    for (const t of BITBUCKET_MCP_TOOLS) assert.ok(!t.includes("jira_"), `bitbucket tool must not be a jira tool: ${t}`);
  });
  it("mcpToolsFor dispatches per tracker and stays empty for the rest", () => {
    assert.deepEqual(mcpToolsFor("jira"), JIRA_MCP_TOOLS);
    assert.deepEqual(mcpToolsFor("bitbucket"), BITBUCKET_MCP_TOOLS);
    assert.deepEqual(mcpToolsFor("github"), []);
    assert.deepEqual(mcpToolsFor("linear"), []);
    assert.deepEqual(mcpToolsFor("bogus"), []);
  });
  it("window JQL mirrors GitHub intention: assignee=@me + updated in window", () => {
    // GitHub listPRs intention is `--author=@me --updated=<date>..<date>` where
    // date = win.date ?? ymd(from). Jira mirrors it as assignee + updated window.
    const jql = jiraWindowJql(WIN);
    assert.equal(jql, 'assignee = currentUser() AND updated >= "2026-11-17 00:00" AND updated < "2026-11-18 00:00" ORDER BY updated DESC');
    assert.ok(jql.includes("assignee = currentUser()"));
    assert.ok(jql.includes("updated"));
  });
  it("jira JQL shares exact window semantics with GitHub search (to/until via windowEnd)", () => {
    const WIN_TO_LOCAL = { key: "2026-11-17", date: "2026-11-17", label: "Monday", from: new Date("2026-11-17T00:00:00Z").getTime(), to: new Date("2026-11-17T23:59:59Z").getTime() };
    // Same window via legacy `until` must produce the same JQL.
    assert.equal(jiraWindowJql(WIN_TO_LOCAL), jiraWindowJql(WIN));
    // GitHub window date for both shapes is the same single day.
    const ghDate = (w) => w?.date ?? "2026-11-17";
    assert.equal(ghDate(WIN_TO_LOCAL), ghDate(WIN));
    assert.ok(jiraWindowJql(WIN_TO_LOCAL).includes(ghDate(WIN_TO_LOCAL)));
  });
  it("jira JQL stays window-aware for date-only windows (same date GitHub would search)", () => {
    const dateOnly = { date: "2026-11-17" };
    const jql = jiraWindowJql(dateOnly);
    assert.ok(jql.includes("assignee = currentUser()"));
    assert.ok(jql.includes("2026-11-17"));
    assert.ok(jql.includes("updated"));
  });
});

describe("jira JQL time bounds (single-day + late-final-day regression)", () => {
  it("single-day window (d0==d1) emits a full-day time-bounded range, not midnight-collapsed", () => {
    // WIN spans one day; bare `updated <= "YYYY-MM-DD"` reads as midnight in
    // Jira and matches nothing updated after 00:00. The exclusive next-day
    // upper bound covers the full final day without minute-boundary risk.
    const jql = jiraWindowJql(WIN);
    assert.ok(jql.includes('updated >= "2026-11-17 00:00"'), `lower bound must pin start of day: ${jql}`);
    assert.ok(jql.includes('updated < "2026-11-18 00:00"'), `upper bound must be exclusive next-day midnight: ${jql}`);
    assert.ok(!jql.includes('updated <= "2026-11-17 23:59"'), `must not use inclusive minute upper bound: ${jql}`);
  });
  it("late-final-day updates fall inside the emitted JQL window", () => {
    const jql = jiraWindowJql(WIN);
    assert.ok(jql.includes('updated < "2026-11-18 00:00"'), `exclusive upper bound required: ${jql}`);
    const bounds = [...jql.matchAll(/"(\d{4}-\d{2}-\d{2} \d{2}:\d{2})"/g)].map((m) => m[1]);
    assert.equal(bounds.length, 2);
    const lo = Date.parse(`${bounds[0].replace(" ", "T")}:00`);
    const hiExclusive = Date.parse(`${bounds[1].replace(" ", "T")}:00`);
    for (const t of ["2026-11-17T00:00:00", "2026-11-17T12:00:00", "2026-11-17T23:45:00", "2026-11-17T23:59:00", "2026-11-17T23:59:59"]) {
      const ts = Date.parse(t);
      assert.ok(ts >= lo && ts < hiExclusive, `${t} must fall inside exclusive JQL window ${bounds.join(" .. ")}`);
    }
    assert.ok(!(Date.parse("2026-11-18T00:00:00") >= lo && Date.parse("2026-11-18T00:00:00") < hiExclusive) === false ||
      Date.parse("2026-11-18T00:00:00") >= hiExclusive, "next-day midnight is exclusive");
  });
  it("multi-day windows span start-of-first-day to exclusive next-day midnight", () => {
    const multi = { from: new Date("2026-11-15T00:00:00Z").getTime(), until: new Date("2026-11-17T23:59:59Z").getTime() };
    const jql = jiraWindowJql(multi);
    assert.ok(jql.includes('updated >= "2026-11-15 00:00"'), jql);
    assert.ok(jql.includes('updated < "2026-11-18 00:00"'), jql);
  });
});

describe("MCP prompt content (Claude + OpenCode prompt-only)", () => {
  it("jira MCP prompt names the server, JQL search, pagination, read-only", () => {
    const p = jiraMcpPrompt(WIN, { baseUrl: "https://example.atlassian.net" });
    assert.ok(p.includes("atlassian-mcp"));
    assert.ok(p.includes("jira_search"));
    assert.ok(p.includes("JQL"));
    assert.ok(p.includes("2026-11-17"));
    assert.ok(/read only/i.test(p));
    assert.ok(/pagina/i.test(p));
    assert.ok(p.includes("jira_get_issue"));
  });
  it("jira MCP prompt, REST fallback and standup prompt share the same JQL", async () => {
    const { standupPrompt } = await import("./local.js");
    const jql = jiraWindowJql(WIN);
    const mcp = jiraMcpPrompt(WIN, { baseUrl: "https://example.atlassian.net" });
    assert.ok(mcp.includes(jql), "MCP prompt must embed jiraWindowJql");
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    };
    const s = patch(withDefaults({}), { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://example.atlassian.net", enabled: true } } });
    await jiraTracker.listIssues({ fetch, getEnv: getEnvFull }, s, WIN);
    assert.ok(decodeURIComponent(calls[0]).includes(jql), "REST must use jiraWindowJql");
    const prompt = standupPrompt(WIN, { commits: [], prs: [], issues: [], tasks: [], slack: [] });
    assert.ok(prompt.includes(jql), "standup prompt must embed the same JQL");
  });
  it("bitbucket MCP prompt names workspace, state filter, pagination, read-only", () => {
    const p = bitbucketMcpPrompt(WIN, { workspace: "acme" });
    assert.ok(p.includes("bitbucket-mcp"));
    assert.ok(p.includes("acme"));
    assert.ok(/state/i.test(p));
    assert.ok(/pagina/i.test(p));
    assert.ok(/read only/i.test(p));
    assert.ok(p.includes("list_pull_requests") || p.includes("get_pull_requests"));
  });
  it("MCP prompts never leak credentials", () => {
    const env = { ATLASSIAN_EMAIL: "me@example.com", ATLASSIAN_API_TOKEN: "tok123" };
    const jp = jiraMcpPrompt(WIN, { baseUrl: "https://example.atlassian.net", ...env });
    const bp = bitbucketMcpPrompt(WIN, { workspace: "acme", ...env });
    for (const p of [jp, bp]) {
      assert.ok(!p.includes("tok123"));
      assert.ok(!p.includes("me@example.com"));
    }
  });
});

describe("REST fallback when MCP is unavailable", () => {
  it("jira REST still answers via ATLASSIAN_* when no MCP run happens", async () => {
    const s = patch(withDefaults({}), { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://example.atlassian.net", enabled: true } } });
    const fetch = async (url) => {
      assert.ok(url.includes("/rest/api/3/search/jql"));
      return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    };
    const r = await listAllIssues({ fetch, getEnv: getEnvFull }, s, WIN);
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.errors, []);
  });
  it("bitbucket REST still answers via ATLASSIAN_* when no MCP run happens", async () => {
    const s = patch(withDefaults({}), { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true } } });
    const fetch = async (url) => {
      assert.ok(url.includes("api.bitbucket.org"));
      return { ok: true, status: 200, json: async () => ({ values: [] }) };
    };
    const noExec = async () => ({ code: 0, stdout: "[]" });
    const r = await listAllPRs({ exec: noExec, fetch, getEnv: getEnvFull }, s, WIN);
    assert.ok(Array.isArray(r.prs));
    assert.deepEqual(r.errors, []);
  });
});

describe("windowFor-shaped windows (exact {from,to} shape, legacy {from,until} accepted)", () => {
  // windowFor() in standup.js emits {key,date,label,from,to}; trackers must
  // honor `to`, accepting legacy `until` for older callers/tests.
  const WIN_TO = { key: "2026-11-17", date: "2026-11-17", label: "Monday", from: new Date("2026-11-17T00:00:00Z").getTime(), to: new Date("2026-11-17T23:59:59Z").getTime() };
  const bbSettings = () => patch(withDefaults({}), { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true } } });
  const jiraSettings = () => patch(withDefaults({}), { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://example.atlassian.net", enabled: true } } });
  const bbPr = (id, updated_on) => ({ id, title: `PR ${id}`, links: { html: { href: `https://bitbucket.org/acme/r/pull-requests/${id}` } }, state: "OPEN", updated_on });
  it("bitbucket filters to the window using `to`", async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ values: [bbPr(1, "2026-11-17T10:00:00+00:00"), bbPr(9, "2026-11-10T00:00:00+00:00")] }) });
    const r = await bitbucketTracker.listPRs({ fetch, getEnv: getEnvFull }, bbSettings(), WIN_TO);
    assert.equal(r.status, "ok");
    assert.equal(r.prs.length, 1);
    assert.equal(r.prs[0].number, 1);
  });
  it("bitbucket `to` and legacy `until` agree on the same window", async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ values: [bbPr(1, "2026-11-17T10:00:00+00:00"), bbPr(9, "2026-11-10T00:00:00+00:00")] }) });
    const a = await bitbucketTracker.listPRs({ fetch, getEnv: getEnvFull }, bbSettings(), WIN_TO);
    const b = await bitbucketTracker.listPRs({ fetch, getEnv: getEnvFull }, bbSettings(), WIN);
    assert.deepEqual(a.prs.map((p) => p.number), b.prs.map((p) => p.number));
  });
  it("jira JQL pins the window from `to`-shaped windows", async () => {
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    };
    const r = await jiraTracker.listIssues({ fetch, getEnv: getEnvFull }, jiraSettings(), WIN_TO);
    assert.equal(r.status, "ok");
    assert.ok(decodeURIComponent(calls[0]).includes("2026-11-17"));
    assert.ok(decodeURIComponent(calls[0]).includes("assignee = currentUser()"));
  });
  it("jira `to` and legacy `until` produce the same JQL", async () => {
    assert.equal(jiraWindowJql(WIN_TO), jiraWindowJql(WIN));
  });
});

describe("unbounded pagination (follow next/nextPageToken until exhausted)", () => {
  const bbSettings = () => patch(withDefaults({}), { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true } } });
  const jiraSettings = () => patch(withDefaults({}), { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "https://example.atlassian.net", enabled: true } } });
  it("bitbucket follows more than 10 pages until next is exhausted", async () => {
    let n = 0;
    const fetch = async (url) => {
      n++;
      const next = n < 12 ? `https://api.bitbucket.org/2.0/x?page=${n + 1}` : null;
      return { ok: true, status: 200, json: async () => ({ next, values: [{ id: n, title: `PR ${n}`, links: { html: { href: `https://bitbucket.org/acme/r/pull-requests/${n}` } }, state: "OPEN", updated_on: "2026-11-17T10:00:00+00:00" }] }) };
    };
    const r = await bitbucketTracker.listPRs({ fetch, getEnv: getEnvFull }, bbSettings(), WIN);
    assert.equal(r.status, "ok");
    assert.equal(r.prs.length, 12);
    assert.equal(r.truncated ?? false, false);
  });
  it("jira follows more than 20 pages until isLast", async () => {
    let n = 0;
    const fetch = async () => {
      n++;
      const last = n >= 25;
      return { ok: true, status: 200, json: async () => ({ issues: [{ key: `ENG-${n}`, fields: { summary: `T${n}`, status: { name: "Done" }, updated: "2026-11-17T10:00:00.000+0000" } }], isLast: last, ...(last ? {} : { nextPageToken: `tok${n}` }) }) };
    };
    const r = await jiraTracker.listIssues({ fetch, getEnv: getEnvFull }, jiraSettings(), WIN);
    assert.equal(r.status, "ok");
    assert.equal(r.issues.length, 25);
    assert.equal(r.truncated ?? false, false);
  });
});

describe("https-only credentials (http rejected unless explicit localhost test flag)", () => {
  const bbHttp = () => patch(withDefaults({}), { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true, baseUrl: "http://example.com" } } });
  const jiraHttp = () => patch(withDefaults({}), { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "http://example.com", enabled: true } } });
  it("isSecureBase requires https, allowing http localhost only with the flag", () => {
    assert.equal(isSecureBase("https://example.atlassian.net"), true);
    assert.equal(isSecureBase("http://example.com"), false);
    assert.equal(isSecureBase("http://localhost:8080"), false);
    assert.equal(isSecureBase("http://localhost:8080", { allowInsecureLocalhost: true }), true);
    assert.equal(isSecureBase("http://127.0.0.1:8080", { allowInsecureLocalhost: true }), true);
    assert.equal(isSecureBase("not a url"), false);
    assert.equal(isSecureBase(""), false);
  });
  it("bitbucket rejects http bases without sending credentials", async () => {
    let called = false;
    const fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({ values: [] }) }; };
    const r = await bitbucketTracker.listPRs({ fetch, getEnv: getEnvFull }, bbHttp(), WIN);
    assert.equal(r.status, "error");
    assert.equal(called, false);
    assert.ok(!(r.error ?? "").includes("tok123"));
    assert.ok(!(r.error ?? "").includes("me@example.com"));
  });
  it("jira rejects http bases without sending credentials", async () => {
    let called = false;
    const fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({ values: [] }) }; };
    const r = await jiraTracker.listIssues({ fetch, getEnv: getEnvFull }, jiraHttp(), WIN);
    assert.equal(r.status, "error");
    assert.equal(called, false);
    assert.ok(!(r.error ?? "").includes("tok123"));
    assert.ok(!(r.error ?? "").includes("me@example.com"));
  });
  it("http localhost is allowed only with the explicit test flag", async () => {
    const s = patch(withDefaults({}), { trackers: { issues: ["linear", "jira"], jira: { baseUrl: "http://localhost:8080", enabled: true } } });
    let called = false;
    const fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) }; };
    const denied = await jiraTracker.listIssues({ fetch, getEnv: getEnvFull }, s, WIN);
    assert.equal(denied.status, "error");
    assert.equal(called, false);
    const r = await jiraTracker.listIssues({ fetch, getEnv: getEnvFull, allowInsecureLocalhost: true }, s, WIN);
    assert.equal(r.status, "ok");
    assert.equal(called, true);
  });
  it("bitbucket never follows pagination to a foreign origin with credentials", async () => {
    const s = patch(withDefaults({}), { trackers: { repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true } } });
    const requested = [];
    const fetch = async (url) => {
      requested.push(url);
      if (String(url).includes("evil.example")) throw new Error("must not fetch a foreign origin with credentials");
      return { ok: true, status: 200, json: async () => ({ next: "https://evil.example/x", values: [{ id: 1, title: "P", links: { html: { href: "https://bitbucket.org/acme/r/pull-requests/1" } }, state: "OPEN", updated_on: "2026-11-17T10:00:00+00:00" }] }) };
    };
    const r = await bitbucketTracker.listPRs({ fetch, getEnv: getEnvFull }, s, WIN);
    assert.equal(r.status, "ok");
    assert.equal(r.prs.length, 1);
    assert.equal(r.truncated, true);
    assert.ok(requested.every((u) => !String(u).includes("evil.example")));
  });
});

describe("Jira MCP read/write split (standup stays read-only)", () => {
  it("exposes read-only and write tool lists composing the full set", async () => {
    assert.deepEqual(JIRA_MCP_READ, ["ToolSearch", "mcp__atlassian-mcp__jira_search", "mcp__atlassian-mcp__jira_get_issue"]);
    assert.deepEqual(JIRA_MCP_WRITE, ["mcp__atlassian-mcp__jira_transition_issue", "mcp__atlassian-mcp__jira_add_comment"]);
    assert.deepEqual(JIRA_MCP_TOOLS, [...JIRA_MCP_READ, ...JIRA_MCP_WRITE]);
    for (const t of JIRA_MCP_READ) assert.ok(!/transition|comment/.test(t), `read tool must not write: ${t}`);
  });
  it("standup tools stay read-only (no transitions/comments)", async () => {
    const { STANDUP_TOOLS } = await import("./local.js");
    assert.ok(!STANDUP_TOOLS.includes("mcp__atlassian-mcp__jira_transition_issue"));
    assert.ok(!STANDUP_TOOLS.includes("mcp__atlassian-mcp__jira_add_comment"));
    assert.ok(STANDUP_TOOLS.includes("mcp__atlassian-mcp__jira_search"));
    assert.ok(STANDUP_TOOLS.includes("mcp__atlassian-mcp__jira_get_issue"));
    assert.equal(STANDUP_TOOLS[0], "ToolSearch");
  });
});

describe("prompt escaping for remote titles", () => {
  it("frames PR titles as single quoted lines (no newlines, quotes escaped)", () => {
    const prs = [{ source: "github", number: 1, title: 'Fix "all"\nthe things', url: "U", state: "open", draft: false, repo: "o/r" }];
    const line = formatPRsForPrompt(prs)[0];
    assert.ok(!line.includes("\n"));
    assert.ok(line.includes("o/r #1"));
    assert.ok(line.includes('\\"all\\"'));
  });
  it("frames issue titles as single lines and bounds runaway titles", () => {
    const issues = [{ source: "jira", key: "ENG-1", identifier: "ENG-1", title: `Do\nthings ${"x".repeat(500)}`, url: "U", state: "Todo" }];
    const line = formatIssuesForPrompt(issues)[0];
    assert.ok(!line.includes("\n"));
    assert.ok(line.includes("ENG-1"));
    assert.ok(line.length < 300);
  });
});
