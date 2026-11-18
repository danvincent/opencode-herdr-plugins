// Pluggable trackers: repository trackers (github, bitbucket) and issue trackers
// (linear, jira). GitHub and Bitbucket can coexist; Linear and Jira can coexist.
//
// REST goes through injected fetch, never MCP and never unverified CLI flags.
// The historical `gh` invocations are wrapped without changing flags.
// Linear keeps its existing headless flow (Claude tools + OpenCode prompt
// adaptation in shell-ai.js); this module only reports whether it is on.
// Jira and Bitbucket prefer their MCP servers first (Claude: --allowedTools
// via ToolSearch; OpenCode: prompt-only `opencode run <prompt>` naming the
// server and tools). REST via ATLASSIAN_EMAIL/ATLASSIAN_API_TOKEN/
// ATLASSIAN_BASE_URL stays as the fallback when MCP is unavailable, using the
// same time windows and pagination. Native mcp-atlassian env
// (JIRA_URL/JIRA_USERNAME/JIRA_API_TOKEN) belongs to the MCP server config;
// this repo's REST fallback stays on ATLASSIAN_* per user instruction.
// No credentials are ever written to logs, errors, or prompts; see sanitizeError.

export const TRACKER_IDS = ["github", "bitbucket", "linear", "jira"];
export const REPOSITORY_TRACKERS = ["github", "bitbucket"];
export const ISSUE_TRACKERS = ["linear", "jira"];
export const DEFAULT_REPOSITORIES = ["github"];
export const DEFAULT_ISSUES = ["linear"];

export const TRACKER_DEFAULTS = {
  repositories: [...DEFAULT_REPOSITORIES],
  issues: [...DEFAULT_ISSUES],
  bitbucket: { workspace: "", enabled: false, baseUrl: "" },
  jira: { baseUrl: "", enabled: false },
};

export const BITBUCKET_API = "https://api.bitbucket.org/2.0";

const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const windowDate = (win) => win?.date ?? (typeof win?.from === "number" ? ymd(win.from) : ymd(Date.now()));

// windowFor() emits {from,to}; legacy callers/tests pass {from,until}.
// Canonical is `to`; accept both everywhere a window end is needed.
export const windowEnd = (win) => win?.to ?? win?.until;

// Credentials go only to validated https origins. Plain http is rejected;
// the injected allowInsecureLocalhost flag exists for tests against a local
// stub server only, never for real credentials.
export function isSecureBase(base, opts = {}) {
  try {
    const u = new URL(String(base));
    if (u.protocol === "https:") return true;
    if (opts?.allowInsecureLocalhost === true && u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(u.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

// Pagination follows next/nextPageToken until exhausted; this guard only
// stops a pathological loop (e.g. a test stub repeating next forever) and
// the caller reports it via truncated instead of partial-as-success.
const MAX_REST_PAGES = 500;

// Never let a secret reach a log line or shared state. Callers build errors
// from status codes only; this is defense in depth for provider messages.
export function sanitizeError(e) {
  let msg = String(e?.message ?? e ?? "request failed");
  msg = msg.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  msg = msg.replace(/Basic\s+[A-Za-z0-9+/=_-]+/gi, "Basic [redacted]");
  msg = msg.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  msg = msg.replace(/\b(?=[A-Za-z]*\d)(?=\w*\d)[A-Za-z0-9+/=_-]{6,}\b/g, "[redacted]");
  return msg.slice(0, 160);
}

const basicAuth = (email, token) =>
  `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;

const envOf = (getEnv) =>
  typeof getEnv === "function" ? getEnv : (k) => process.env?.[k];

export function getRepositoryIds(settings) {
  const r = settings?.trackers?.repositories;
  return Array.isArray(r) ? [...r] : [...DEFAULT_REPOSITORIES];
}

export function getIssueIds(settings) {
  const r = settings?.trackers?.issues;
  return Array.isArray(r) ? [...r] : [...DEFAULT_ISSUES];
}

// Enabled = selected in the list AND its legacy/enabled flag on. Configured =
// credentials present. A tracker that is enabled but not configured is
// skipped, not an error; callers distinguish empty from auth-failure.
export function isTrackerEnabled(settings, id) {
  if (id === "github") return getRepositoryIds(settings).includes("github") && settings?.github?.enabled !== false;
  if (id === "bitbucket") return getRepositoryIds(settings).includes("bitbucket") && settings?.trackers?.bitbucket?.enabled === true;
  if (id === "linear") return getIssueIds(settings).includes("linear") && settings?.linear?.enabled !== false;
  if (id === "jira") return getIssueIds(settings).includes("jira") && settings?.trackers?.jira?.enabled === true;
  return false;
}

// --- Normalization (one shape per kind, tagged with source) ---

export function normalizeGithubPR(p) {
  return {
    source: "github",
    number: p?.number ?? null,
    title: p?.title ?? "",
    url: p?.url ?? "",
    state: String(p?.state ?? "").toLowerCase(),
    draft: Boolean(p?.isDraft),
    repo: p?.repository?.nameWithOwner ?? p?.repository?.name ?? "",
  };
}

export function normalizeBitbucketPR(p, repoFullName = "") {
  const repo = p?.destination?.repository?.full_name ?? repoFullName ?? "";
  return {
    source: "bitbucket",
    number: p?.id ?? null,
    title: p?.title ?? "",
    url: p?.links?.html?.href ?? "",
    state: String(p?.state ?? "").toLowerCase(),
    draft: Boolean(p?.draft),
    repo,
    branch: p?.source?.branch?.name ?? null,
    updated: p?.updated_on ?? p?.created_on ?? null,
  };
}

export function normalizeJiraIssue(i, baseUrl = "") {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  const key = i?.key ?? "";
  return {
    source: "jira",
    key,
    identifier: key,
    title: i?.fields?.summary ?? "",
    url: key && base ? `${base}/browse/${key}` : "",
    state: i?.fields?.status?.name ?? "",
    updated: i?.fields?.updated ?? null,
  };
}

export function normalizeLinearIssue(i) {
  return { source: "linear", ...(i ?? {}) };
}

const prKey = (p) => `${p?.source}|${p?.repo}|${p?.number}`;
const issueKey = (i) => `${i?.source}|${i?.identifier ?? i?.key}`;

export function mergePRs(...lists) {
  const seen = new Set(), out = [];
  for (const l of lists) for (const p of l ?? []) {
    const k = prKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function mergeIssues(...lists) {
  const seen = new Set(), out = [];
  for (const l of lists) for (const i of l ?? []) {
    const k = issueKey(i);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

export const formatPRsForPrompt = (prs) =>
  (prs ?? []).map((p) => `${p.repo} #${p.number} ${JSON.stringify(oneLine(p.title))} (${p.draft ? "draft" : p.state}) ${p.url}`);

export const formatIssuesForPrompt = (issues) =>
  (issues ?? []).map((i) => `${i.identifier ?? i.key} ${JSON.stringify(oneLine(i.title))} (${i.state}) ${i.url}`);

// Remote titles feed an agent prompt: force one line (embedded newlines or
// quotes must not break the list framing) and bound runaway titles.
const oneLine = (s, max = 200) =>
  String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);

// --- GitHub: exact historical `gh` invocations, wrapped without flag changes ---

async function ghSearchWindow(exec, win) {
  const date = windowDate(win);
  const r = await exec("gh", ["search", "prs", "--author=@me", `--updated=${date}..${date}`,
    "--json", "number,title,url,repository,state,isDraft", "--limit", "30"], { timeout: 20_000 });
  return JSON.parse(r?.stdout || "[]").map(normalizeGithubPR);
}

export const githubTracker = {
  id: "github",
  kind: "repository",
  isConfigured: () => true,
  // Deliberate ok-empty (not error) on gh failure or malformed JSON: a
  // missing/failing gh CLI is "no GitHub data", matching the historical
  // behavior. Real auth/config failures in Bitbucket/Jira stay explicit
  // (auth-error/error) via listAllPRs/listAllIssues errors, so callers can
  // still distinguish failure from empty for those trackers.
  async listPRs({ exec }, win) {
    try {
      return { status: "ok", prs: await ghSearchWindow(exec, win) };
    } catch {
      return { status: "ok", prs: [] };
    }
  },
  // Historical per-branch lookup from main.js sync; flags unchanged. The raw
  // review/rollup fields ride along so the caller keeps its CI mapping.
  async getBranchPR(exec, cwd, branch) {
    const r = await exec("gh", ["pr", "view", branch, "--json", "number,title,url,state,isDraft,reviewDecision,statusCheckRollup"],
      { cwd, timeout: 20_000 }).catch(() => null);
    if (r?.code !== 0) return null;
    try {
      const pr = JSON.parse(r.stdout);
      return { ...normalizeGithubPR({ ...pr, repository: { nameWithOwner: "" } }), review: pr.reviewDecision ?? null, statusCheckRollup: pr.statusCheckRollup ?? null };
    } catch { return null; }
  },
  // Historical review-requests lookup from main.js sync; scope flag passed through.
  async listReviews(exec, scope) {
    const r = await exec("gh", ["search", "prs", scope, "--state=open", "--json", "number,title,url,repository,author", "--limit", "20"], { timeout: 20_000 });
    if (r?.code !== 0) throw new Error((r?.stderr ?? "").trim().split("\n")[0] || "gh search failed");
    return JSON.parse(r.stdout).map((x) => ({ source: "github", number: x.number, title: x.title, url: x.url, repo: x.repository?.nameWithOwner ?? "", author: x.author?.login ?? "" }));
  },
};

// --- Bitbucket Cloud: REST via injected fetch ---

const bitbucketBase = (settings, getEnv) =>
  (settings?.trackers?.bitbucket?.baseUrl?.trim() || envOf(getEnv)("BITBUCKET_BASE_URL") || BITBUCKET_API).replace(/\/+$/, "");
const bitbucketWorkspace = (settings) => settings?.trackers?.bitbucket?.workspace?.trim() ?? "";

export const bitbucketTracker = {
  id: "bitbucket",
  kind: "repository",
  isConfigured(settings, getEnv) {
    const env = envOf(getEnv);
    return Boolean(bitbucketWorkspace(settings) && env("ATLASSIAN_EMAIL") && env("ATLASSIAN_API_TOKEN"));
  },
  async listPRs({ fetch, getEnv, allowInsecureLocalhost }, settings, win) {
    const env = envOf(getEnv);
    const workspace = bitbucketWorkspace(settings);
    const email = env("ATLASSIAN_EMAIL"), token = env("ATLASSIAN_API_TOKEN");
    if (!workspace || !email || !token) return { status: "skipped", prs: [] };
    const run = fetch ?? globalThis.fetch;
    const base = bitbucketBase(settings, getEnv);
    if (!isSecureBase(base, { allowInsecureLocalhost }))
      return { status: "error", prs: [], error: "bitbucket base URL must be https:// (http only for explicit localhost tests)" };
    const baseOrigin = new URL(base).origin;
    const headers = { Authorization: basicAuth(email, token), Accept: "application/json" };
    const from = new Date(win?.from ?? Date.now()).toISOString();
    const until = new Date(windowEnd(win) ?? Date.now()).toISOString();
    let url = `${base}/repositories/${encodeURIComponent(workspace)}/pullrequests?pagelen=50` +
      `&sort=-updated_on&q=${encodeURIComponent(`updated_on >= ${from} AND updated_on <= ${until}`)}` +
      `&fields=${encodeURIComponent("next,values.id,values.title,values.state,values.draft,values.updated_on,values.created_on,values.links.html.href,values.source.branch.name,values.destination.repository.full_name")}`;
    const found = [];
    let truncated = false;
    try {
      let pages = 0;
      while (url) {
        if (++pages > MAX_REST_PAGES) { truncated = true; break; }
        const res = await run(url, { headers });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) return { status: "auth-error", prs: [], error: `bitbucket answered ${res.status}` };
          return { status: "error", prs: [], error: `bitbucket answered ${res.status}` };
        }
        const body = await res.json();
        const end = windowEnd(win);
        for (const v of body?.values ?? []) {
          const t = Date.parse(v?.updated_on ?? v?.created_on ?? "");
          if (Number.isFinite(t) && win?.from != null && end != null && (t < win.from || t > end)) continue;
          found.push(v);
        }
        // Follow `next` only within the validated base origin: credentials
        // must never ride along to an unexpected host.
        const next = body?.next ?? null;
        if (!next) { url = null; continue; }
        let sameOrigin = false;
        try { sameOrigin = new URL(next, base).origin === baseOrigin; } catch { sameOrigin = false; }
        if (!sameOrigin) { truncated = true; url = null; }
        else url = next;
      }
    } catch (e) {
      return { status: "error", prs: [], error: sanitizeError(e) };
    }
    const prs = found.map((v) => normalizeBitbucketPR(v, v?.destination?.repository?.full_name ?? workspace));
    return { status: "ok", prs, truncated };
  },
};

// --- Linear: headless flow lives in main.js + shell-ai.js; unchanged here ---

export const linearTracker = {
  id: "linear",
  kind: "issues",
  isConfigured(settings) {
    return settings?.linear?.enabled !== false && getIssueIds(settings).includes("linear");
  },
  // Linear reads through the Claude connector in a headless run, so there is
  // no REST call to make here. The caller runs the existing headless flow.
  async listIssues() {
    return { status: "headless", issues: [], note: "Linear reads via the headless run (Claude connector / OpenCode prompt)" };
  },
};

// --- Jira Cloud: REST via injected fetch ---

const jiraBase = (settings, getEnv) =>
  (settings?.trackers?.jira?.baseUrl?.trim() || envOf(getEnv)("ATLASSIAN_BASE_URL") || envOf(getEnv)("JIRA_BASE_URL") || "").replace(/\/+$/, "");

const jiraJql = (win) => {
  if (win?.from != null && windowEnd(win) != null) {
    const d0 = ymd(win.from), d1 = ymd(windowEnd(win));
    return `assignee = currentUser() AND updated >= "${d0}" AND updated <= "${d1}" ORDER BY updated DESC`;
  }
  return "assignee = currentUser() AND updated >= startOfDay(-1d) ORDER BY updated DESC";
};

export const jiraTracker = {
  id: "jira",
  kind: "issues",
  isConfigured(settings, getEnv) {
    const env = envOf(getEnv);
    return Boolean(jiraBase(settings, getEnv) && env("ATLASSIAN_EMAIL") && env("ATLASSIAN_API_TOKEN"));
  },
  async listIssues({ fetch, getEnv, allowInsecureLocalhost }, settings, win) {
    const env = envOf(getEnv);
    const base = jiraBase(settings, getEnv);
    const email = env("ATLASSIAN_EMAIL"), token = env("ATLASSIAN_API_TOKEN");
    if (!base || !email || !token) return { status: "skipped", issues: [] };
    if (!isSecureBase(base, { allowInsecureLocalhost }))
      return { status: "error", issues: [], error: "jira base URL must be https:// (http only for explicit localhost tests)" };
    const run = fetch ?? globalThis.fetch;
    const headers = { Authorization: basicAuth(email, token), Accept: "application/json" };
    const fields = "summary,status,updated";
    let url = `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jiraJql(win))}` +
      `&fields=${encodeURIComponent(fields)}&maxResults=50&startAt=0`;
    const found = [];
    let truncated = false;
    try {
      let pages = 0;
      while (url) {
        if (++pages > MAX_REST_PAGES) { truncated = true; break; }
        const res = await run(url, { headers });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) return { status: "auth-error", issues: [], error: `jira answered ${res.status}` };
          return { status: "error", issues: [], error: `jira answered ${res.status}` };
        }
        const body = await res.json();
        for (const i of body?.issues ?? []) found.push(normalizeJiraIssue(i, base));
        const next = body?.nextPageToken;
        url = body?.isLast === false && next
          ? `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jiraJql(win))}` +
            `&fields=${encodeURIComponent(fields)}&maxResults=50&nextPageToken=${encodeURIComponent(next)}`
          : null;
      }
    } catch (e) {
      return { status: "error", issues: [], error: sanitizeError(e) };
    }
    return { status: "ok", issues: found, truncated };
  },
};

// --- MCP-first: Jira via atlassian-mcp-server, Bitbucket via bitbucket-mcp ---
//
// Claude exposure is `mcp__<server>__<tool>` through ToolSearch (passed via
// the unchanged --allowedTools invocation). OpenCode gets no tool flags:
// `opencode run <prompt>` only, so the prompts below name the server and the
// tools explicitly and are self-contained. REST (ATLASSIAN_*) remains the
// fallback when the MCP servers are unavailable; prompts say to fall back to
// the REST-collected lists embedded by the caller. Prompts never carry
// credentials.

// Jira+Confluence only (sooperset/mcp-atlassian, "atlassian-mcp-server").
//
// Split into read vs write: the standup path is read-only by construction and
// takes JIRA_MCP_READ only. JIRA_MCP_TOOLS keeps the full set for callers
// that do act on issues (transitions/comments), so existing imports keep
// working.
export const JIRA_MCP_SERVER = "atlassian-mcp";
export const JIRA_MCP_READ = [
  "ToolSearch",
  "mcp__atlassian-mcp__jira_search",
  "mcp__atlassian-mcp__jira_get_issue",
];
export const JIRA_MCP_WRITE = [
  "mcp__atlassian-mcp__jira_transition_issue",
  "mcp__atlassian-mcp__jira_add_comment",
];
export const JIRA_MCP_TOOLS = [...JIRA_MCP_READ, ...JIRA_MCP_WRITE];

// Bitbucket Cloud only, via the separate bitbucket-mcp server. Both the
// `list_pull_requests` and `get_pull_requests` spellings are allowed because
// server builds differ; `get_pull_request` covers single-PR reads with
// comments/diff helpers alongside.
export const BITBUCKET_MCP_SERVER = "bitbucket-mcp";
export const BITBUCKET_MCP_TOOLS = [
  "ToolSearch",
  "mcp__bitbucket-mcp__list_pull_requests",
  "mcp__bitbucket-mcp__get_pull_requests",
  "mcp__bitbucket-mcp__get_pull_request",
  "mcp__bitbucket-mcp__get_pull_request_comments",
  "mcp__bitbucket-mcp__get_pull_request_diff",
];

// Tool allow-list per tracker for the Claude path. OpenCode ignores this and
// uses the prompt text only; unknown ids get no tools.
export function mcpToolsFor(id) {
  if (id === "jira") return [...JIRA_MCP_TOOLS];
  if (id === "bitbucket") return [...BITBUCKET_MCP_TOOLS];
  return [];
}

// Window-aware JQL shared by the MCP prompt and the REST fallback so both
// cover the same day. Exported for tests; the REST path keeps using it.
export function jiraWindowJql(win) {
  return jiraJql(win);
}

// Self-contained MCP instruction for Jira: load the atlassian-mcp tools with
// ToolSearch (Claude) or via MCP config (OpenCode), run jira_search with the
// window JQL, paginate, then jira_get_issue for details. Read only unless the
// caller asks for a transition/comment; transitions/comments stay out of the
// standup path. Falls back to the caller's REST list when tools are missing.
export function jiraMcpPrompt(win, opts = {}) {
  const jql = jiraJql(win);
  const base = String(opts?.baseUrl ?? "").replace(/\/+$/, "");
  const where = base ? ` on ${base}` : "";
  return `Jira${where} via the ${JIRA_MCP_SERVER} MCP server (Jira+Confluence only). ` +
    `Load the tools with ToolSearch first, then use mcp__atlassian-mcp__jira_search with this JQL: ${jql}. ` +
    `Paginate through every page and use mcp__atlassian-mcp__jira_get_issue for details of each hit. ` +
    `Read only: never transition issues or add comments. ` +
    `If no Jira MCP tools are available, fall back to the REST-collected Jira list in this prompt.`;
}

// Self-contained MCP instruction for Bitbucket: load the bitbucket-mcp tools,
// list PRs for the workspace in the window with a state filter, paginate,
// then get_pull_request (+ comments/diff) for details. Read only. Falls back
// to the caller's REST list when tools are missing.
export function bitbucketMcpPrompt(win, opts = {}) {
  const workspace = String(opts?.workspace ?? "").trim();
  const where = workspace ? ` in workspace "${workspace}"` : "";
  const date = windowDate(win);
  return `Bitbucket${where} via the ${BITBUCKET_MCP_SERVER} MCP server. ` +
    `Load the tools with ToolSearch first, then list pull requests with ` +
    `mcp__bitbucket-mcp__list_pull_requests (or mcp__bitbucket-mcp__get_pull_requests) ` +
    `filtered to updated ${date} 00:00 to 23:59 and state OPEN, MERGED and DECLINED. ` +
    `Paginate through every page (pagelen/next) and use mcp__bitbucket-mcp__get_pull_request ` +
    `with mcp__bitbucket-mcp__get_pull_request_comments and mcp__bitbucket-mcp__get_pull_request_diff for details. ` +
    `Read only: never comment, approve or change anything. ` +
    `If no Bitbucket MCP tools are available, fall back to the REST-collected pull-request list in this prompt.`;
}

// --- Dispatch: configurable, multiple concurrently ---

export async function listAllPRs(deps, settings, win) {
  const ids = getRepositoryIds(settings);
  const jobs = [];
  if (ids.includes("github") && settings?.github?.enabled !== false)
    jobs.push(githubTracker.listPRs(deps, win).then((r) => ({ source: "github", ...r })));
  if (ids.includes("bitbucket") && settings?.trackers?.bitbucket?.enabled === true) {
    if (!bitbucketTracker.isConfigured(settings, deps?.getEnv)) jobs.push(Promise.resolve({ source: "bitbucket", status: "skipped", prs: [] }));
    else jobs.push(bitbucketTracker.listPRs(deps, settings, win).then((r) => ({ source: "bitbucket", ...r })));
  }
  const settled = await Promise.all(jobs);
  const prs = mergePRs(...settled.filter((r) => r.status === "ok").map((r) => r.prs));
  const sources = {};
  for (const r of settled) if (r.status === "ok") sources[r.source] = (r.prs ?? []).length;
  const errors = settled.filter((r) => r.status === "auth-error" || r.status === "error")
    .map((r) => ({ source: r.source, status: r.status, error: r.error ?? r.status }));
  const truncatedSources = {};
  for (const r of settled) if (r.status === "ok" && r.truncated) truncatedSources[r.source] = true;
  return { prs, errors, sources, truncated: Object.keys(truncatedSources).length > 0, truncatedSources };
}

export async function listAllIssues(deps, settings, win) {
  const ids = getIssueIds(settings);
  const jobs = [];
  // Linear stays on its headless flow; REST dispatch covers Jira only.
  if (ids.includes("jira") && settings?.trackers?.jira?.enabled === true) {
    if (!jiraTracker.isConfigured(settings, deps?.getEnv)) jobs.push(Promise.resolve({ source: "jira", status: "skipped", issues: [] }));
    else jobs.push(jiraTracker.listIssues(deps, settings, win).then((r) => ({ source: "jira", ...r })));
  }
  const settled = await Promise.all(jobs);
  const issues = mergeIssues(...settled.filter((r) => r.status === "ok").map((r) => r.issues));
  const sources = {};
  for (const r of settled) if (r.status === "ok") sources[r.source] = (r.issues ?? []).length;
  const errors = settled.filter((r) => r.status === "auth-error" || r.status === "error")
    .map((r) => ({ source: r.source, status: r.status, error: r.error ?? r.status }));
  const truncatedSources = {};
  for (const r of settled) if (r.status === "ok" && r.truncated) truncatedSources[r.source] = true;
  return { issues, errors, sources, truncated: Object.keys(truncatedSources).length > 0, truncatedSources };
}
