// Pure standup drafting logic: no Herdr runtime imports, so plain node can
// test it. standup.js re-exports this module wired to the real herdr fns;
// tests import from here directly with stubbed deps.
//
// Window shape is windowFor()'s {key,date,label,from,to}; legacy {from,until}
// windows are accepted too (see windowEnd in trackers.js).

import { listAllPRs, listAllIssues, formatPRsForPrompt, formatIssuesForPrompt, windowEnd, jiraWindowJql, JIRA_MCP_READ, BITBUCKET_MCP_TOOLS } from "./trackers.js";

export const STANDUP_TIMEOUT = 420_000;
// MCP-first: Linear + Slack on the claude.ai connector, Jira via
// atlassian-mcp-server (sooperset/mcp-atlassian, Jira+Confluence only) and
// Bitbucket Cloud via the separate bitbucket-mcp server. ToolSearch stays
// first; the list is the Claude --allowedTools allow-list, while OpenCode
// gets the same coverage prompt-only via `opencode run <prompt>`.
//
// Read-only by construction: Jira contributes JIRA_MCP_READ (search/get)
// only; the transition/comment tools live in JIRA_MCP_WRITE and never enter
// this path.
const withoutToolSearch = (tools) => tools.filter((t) => t !== "ToolSearch");
export const STANDUP_TOOLS = [
  "ToolSearch",
  "mcp__claude_ai_Linear__list_issues", "mcp__claude_ai_Linear__get_issue", "mcp__claude_ai_Linear__list_comments", "mcp__claude_ai_Linear__whoami",
  "mcp__claude_ai_Slack__slack_search_public_and_private", "mcp__claude_ai_Slack__slack_read_thread", "mcp__claude_ai_Slack__slack_read_user_profile",
  ...withoutToolSearch(JIRA_MCP_READ),
  ...withoutToolSearch(BITBUCKET_MCP_TOOLS),
];

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Before the cut-over hour (default 18:00): the previous working day (Friday on Monday). From it: today.
export function windowFor(now = new Date(), cutover = 18) {
  const d = new Date(now);
  if (d.getHours() < cutover) {
    d.setDate(d.getDate() - 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  }
  const from = new Date(d); from.setHours(0, 0, 0, 0);
  const to = new Date(d); to.setHours(23, 59, 59, 999);
  const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return { key: ymd(d), date: ymd(d), label: DAY[d.getDay()], from: from.getTime(), to: to.getTime() };
}

// The latest scheduled time at or before now, in this Mac's time zone: { id: "2026-11-11@23", at }.
// hours: settings' standup.times; weekdaysOnly skips Saturday and Sunday.
export function standupSlot(now = new Date(), hours = [23], weekdaysOnly = true) {
  for (let back = 0; back < 4; back++) {
    const d = new Date(now);
    d.setDate(d.getDate() - back);
    if (weekdaysOnly && (d.getDay() === 0 || d.getDay() === 6)) continue;
    for (const h of [...hours].sort((a, b) => b - a)) {
      d.setHours(h, 0, 0, 0);
      if (d <= now) return { id: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}@${h}`, at: d.getTime() };
    }
  }
  return null;
}

const noopExec = async () => ({ code: 1, stdout: "", stderr: "" });

async function repos(deps) {
  const exec = deps?.exec ?? noopExec;
  const shared = deps?.shared ?? (() => ({}));
  const home = deps?.home ?? (() => "/tmp/cc-no-home");
  const roots = shared("cc.settings")?.roots ?? [];
  const found = new Set();
  for (const dir of [...roots, `${home()}/.herdr/worktrees`]) {
    const r = await exec("find", [dir, "-maxdepth", "3", "-name", ".git", "-not", "-path", "*/node_modules/*"], { timeout: 15_000 }).catch(() => null);
    for (const line of (r?.stdout ?? "").split("\n").filter(Boolean)) found.add(line.replace(/\/\.git$/, ""));
  }
  return [...found];
}

// Commits, PRs and task summaries from the window, as plain lines for the prompt.
// Repository trackers (GitHub via gh, Bitbucket via REST fallback) merge concurrently;
// Jira issues arrive via REST fallback when configured (Linear stays on its headless run).
// The headless run prefers MCP first (atlassian-mcp jira_search, bitbucket-mcp PR tools)
// with these REST lists as the fallback; MCP tools are never called from here.
// Without settings (or without tracker config) this is the historical GitHub-only path.
//
// Tracker failures are propagated as prErrors/issueErrors (plus a merged
// sources map) so callers can tell failure apart from empty; the historical
// {commits,prs,issues,tasks,slack} fields are unchanged.
export async function gatherLocal(win, settings = null, deps = {}) {
  const end = windowEnd(win) ?? win?.from;
  const since = new Date(win.from).toISOString(), until = new Date(end).toISOString();
  const exec = deps?.exec ?? noopExec;
  const readTextFile = deps?.readTextFile ?? (async () => { throw new Error("no fs"); });
  const appHome = deps?.appHome ?? (() => "/tmp/cc-no-home");
  const commits = [], tasks = [];
  const seen = new Set();
  for (const repo of await repos(deps)) {
    const email = (await exec("git", ["config", "user.email"], { cwd: repo }).catch(() => null))?.stdout.trim();
    if (email) {
      const r = await exec("git", ["log", "--all", `--author=${email}`, `--since=${since}`, `--until=${until}`, "--no-merges", "--pretty=%h %s", "-n", "25"], { cwd: repo, timeout: 15_000 }).catch(() => null);
      for (const line of (r?.stdout ?? "").split("\n").filter(Boolean)) {
        const subject = line.slice(line.indexOf(" ") + 1);
        if (!seen.has(`${repo}|${subject}`)) { seen.add(`${repo}|${subject}`); commits.push(`${repo.split("/").pop()}: ${subject}`); }
      }
    }
    const list = await exec("find", [`${repo}/.agents/tasks/.summary`, "-name", "*.json", "-newermt", since], { timeout: 10_000 }).catch(() => null);
    for (const file of (list?.stdout ?? "").split("\n").filter(Boolean)) {
      let s = null;
      try { s = JSON.parse(await readTextFile(file)); } catch { continue; }
      if (!s?.updatedAt || s.updatedAt < win.from || s.updatedAt > end + 6 * 3600_000) continue;
      const done = (s.steps ?? []).filter((x) => x.state === "done").map((x) => x.text).slice(0, 5);
      tasks.push(`${s.title}: ${s.goal}${done.length ? ` Done: ${done.join("; ")}` : ""}${s.notDone?.length ? ` Open: ${s.notDone.slice(0, 2).join("; ")}` : ""}`);
    }
  }
  // Pull requests across the configured repository trackers (GitHub and
  // Bitbucket can coexist). Missing config is skipped, not an error.
  const cfg = settings ?? { github: { enabled: true }, trackers: { repositories: ["github"] } };
  const rest = { fetch: deps.fetch ?? globalThis.fetch, getEnv: deps.getEnv ?? ((k) => process.env?.[k]) };
  const [prOut, issueOut] = await Promise.all([
    listAllPRs({ exec, ...rest }, cfg, win).catch(() => ({ prs: [], errors: [], sources: {}, truncated: false, truncatedSources: {} })),
    listAllIssues(rest, cfg, win).catch(() => ({ issues: [], errors: [], sources: {}, truncated: false, truncatedSources: {} })),
  ]);
  const prs = formatPRsForPrompt(prOut.prs);
  const issues = formatIssuesForPrompt(issueOut.issues);
  // Slack asks closed that day: ticked by you, or resolved because you replied. Skipped ones aren't in the log.
  let slack = [];
  try {
    const state = JSON.parse(await readTextFile(`${appHome()}/data/cc-slack/state.json`) ?? "{}");
    slack = (state.handled ?? []).filter((h) => h.at >= win.from && h.at <= end)
      .map((h) => `${h.from} (${h.channel}) asked: "${h.text}" (${h.by === "sweep" ? "I replied in Slack" : "I marked it done"})`);
  } catch { /* no Slack state yet */ }
  const prTruncated = Boolean(prOut.truncated);
  const issueTruncated = Boolean(issueOut.truncated);
  return {
    commits: commits.slice(0, 80), prs, issues, tasks: tasks.slice(0, 20), slack: slack.slice(0, 20),
    prErrors: prOut.errors ?? [], issueErrors: issueOut.errors ?? [],
    sources: { ...(prOut.sources ?? {}), ...(issueOut.sources ?? {}) },
    prTruncated, issueTruncated,
    truncated: prTruncated || issueTruncated,
    truncatedSources: { ...(prOut.truncatedSources ?? {}), ...(issueOut.truncatedSources ?? {}) },
  };
}

export function standupPrompt(win, local) {
  const list = (title, xs) => `${title}:\n${(xs ?? []).length ? xs.map((x) => `- ${x}`).join("\n") : "(none)"}`;
  const gaps = [...(local?.prErrors ?? []), ...(local?.issueErrors ?? [])]
    .map((e) => `${e.source}: ${e.error ?? e.status}`);
  const truncatedNames = [
    ...Object.keys(local?.truncatedSources ?? {}),
    ...((local?.prTruncated && Object.keys(local?.truncatedSources ?? {}).length === 0) ? ["prs"] : []),
    ...((local?.issueTruncated && Object.keys(local?.truncatedSources ?? {}).length === 0) ? ["issues"] : []),
  ].filter((v, i, a) => a.indexOf(v) === i);
  const truncated = truncatedNames.length > 0 || local?.truncated === true;
  return `Write my standup answer to "What did you accomplish?" for ${win.label}, ${win.date}. Nobody reads a chat; your answer is the JSON.
Load the Linear, Slack, Jira (atlassian-mcp) and Bitbucket (bitbucket-mcp) tools with ToolSearch, then:
1. Linear: issues assigned to me or that I commented on or moved between ${win.date} 00:00 and 23:59 my time. Read only.
Jira first via the atlassian-mcp MCP server (Jira+Confluence only): mcp__atlassian-mcp__jira_search with JQL '${jiraWindowJql(win)}', paginate every page, mcp__atlassian-mcp__jira_get_issue for details. Read only: never transition or comment. Jira issues already collected over REST (ATLASSIAN_* fallback) are listed below under "Jira issues updated"; use that list when no Jira MCP tools are available.
Bitbucket first via the bitbucket-mcp MCP server: mcp__bitbucket-mcp__list_pull_requests (or get_pull_requests) for the window with a state filter, paginate every page, mcp__bitbucket-mcp__get_pull_request with comments/diff for details. Read only. Pull requests already collected over REST are listed below; use that list when no Bitbucket MCP tools are available.
2. Slack: messages I sent in that window (from:me), for work that didn't leave a commit: reviews, debugging help, decisions. Read only.

What I did locally that day:
${list("Commits", local.commits)}

${list("Pull requests I opened or updated", local.prs)}

${list("Jira issues updated", local.issues ?? local.jira)}

${list("Agent task summaries", local.tasks)}

${list("Slack asks I handled", local.slack)}
${gaps.length ? `
Tracker gaps (missing data, not empty days): treat these as unknown, not as nothing happening.
${gaps.map((g) => `- ${g}`).join("\n")}
` : ""}${truncated ? `
Tracker truncated (partial data, not complete): capped pagination, treat these as partial, not as nothing happening.
${truncatedNames.map((g) => `- ${g}: truncated`).join("\n")}
` : ""}
Write 3 to 7 bullets, one line each, outcome first, grouped by ticket or project where it helps. Name Linear IDs and PR numbers.
Merge the agent summaries with the commits instead of repeating them. Skip trivia (formatting, typo fixes, merges).
A Slack ask earns a bullet only when it was real work (a review, a fix, a decision, an unblock); fold it into the matching
project bullet when there is one, and leave out acknowledgements and quick answers.
Plain, direct sentences: no filler, no "successfully", no hype. If something is blocked, end with one line starting "Blocked:".
text: just the bullets, each starting with "- ".
Never post, comment or change anything. If the tools fail, still write from the local facts and put one short reason in error.`;
}
