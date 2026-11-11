// Slack sweep: a headless Sonnet run with read-only Slack tools finds asks and FYIs in DMs and @-mentions
// since the last sweep.
// State lives in <appHome>/data/cc-slack/state.json; the Inbox sees it as shared "cc.slack".

import * as fs from "fs/promises";

export const SLACK_TIMEOUT = 600_000;
export const SLACK_TOOLS = [
  "ToolSearch",
  "mcp__claude_ai_Slack__slack_search_public_and_private",
  "mcp__claude_ai_Slack__slack_search_public",
  "mcp__claude_ai_Slack__slack_read_channel",
  "mcp__claude_ai_Slack__slack_read_thread",
  "mcp__claude_ai_Slack__slack_read_user_profile",
  "mcp__claude_ai_Slack__slack_search_users",
  "mcp__claude_ai_Slack__slack_get_reactions",
];

const ITEM = {
  type: "object", required: ["permalink", "kind", "from", "channel", "text", "urgent"],
  properties: {
    permalink: { type: "string" }, kind: { enum: ["ask", "fyi"] }, from: { type: "string" }, channel: { type: "string" },
    text: { type: "string" }, due: { type: "string" }, urgent: { type: "boolean" },
  },
};
export const SLACK_SCHEMA = JSON.stringify({
  type: "object", required: ["items", "resolved", "error", "connected"],
  properties: {
    me: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, tz: { type: "string" } } },
    items: { type: "array", items: ITEM },
    resolved: { type: "array", items: { type: "string" } },
    error: { type: "string" }, connected: { type: "boolean" },
  },
});

export function slackPrompt(state, now) {
  const after = state.lastAt ? new Date(state.lastAt - 10 * 60_000) : new Date(now - 24 * 3600_000);
  const open = state.items.filter((i) => !i.ticked).map((i) => `- ${i.permalink} | ${i.from} in ${i.channel}: ${i.text.slice(0, 100)}`);
  return `You run one headless Slack sweep for me. Nobody reads a chat; your answer is the JSON. Load the Slack tools with ToolSearch first.
Me: ${state.me ? `${state.me.name} (${state.me.id}), timezone ${state.me.tz}` : "unknown yet: read my own profile first and return it as me"}.
Now: ${new Date(now).toISOString()}. Look at messages since ${after.toISOString()}.

1. Look only at DMs and group DMs to me, and messages anywhere that @-mention me. Nothing else.
2. For each candidate, read its thread. Skip it if I already replied or someone else settled it.
3. kind "ask": needs my answer or action. due: the deadline in words if one is stated, else empty. urgent: true for a blocker, a deadline today, or a direct ask from my manager. kind "fyi": I should know, nothing to do. Leave out chatter, bots, and anything I wrote.
4. These are still open from earlier sweeps. Put a permalink in resolved when I have since replied or it no longer needs me:
${open.length ? open.join("\n") : "(none)"}
Do not return those again as items unless something new happened in them.

text: the ask in one sentence, in the asker's words where possible, under 200 characters. channel: "#name", or "DM", or "group DM". from: the person's display name.
Read only: never post, reply, react, draft, schedule or change anything.
connected: false when no Slack tools are available or they say I need to sign in; then return empty lists.
If the Slack tools are there but keep failing, return empty lists and one short reason in error; otherwise error is "".`;
}

export const emptyState = () => ({ me: null, lastAt: 0, items: [], dismissed: [], handled: [], runs: [] });

export async function loadState(path) {
  try { return { ...emptyState(), ...JSON.parse(await fs.readFile(path, "utf8")) }; } catch { return emptyState(); }
}

export async function saveState(path, state) {
  // Herdr's fs has no rename; cc-status queues every write, so a plain write is safe.
  await fs.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await fs.writeFile(path, JSON.stringify(state, null, 2));
}

// Folds one sweep's answer into the state; returns the asks that are new and worth a toast.
export function merge(state, out, now) {
  if (out.me?.id) state.me = out.me;
  const fresh = [];
  for (const it of out.items ?? []) {
    if (!it.permalink || state.dismissed.includes(it.permalink)) continue;
    const old = state.items.find((x) => x.permalink === it.permalink);
    if (old) Object.assign(old, { ...it, ticked: old.ticked, tickedAt: old.tickedAt, at: old.at });
    else { state.items.push({ ...it, at: now, ticked: false, tickedAt: null }); if (it.kind === "ask" && (it.urgent || it.due)) fresh.push(it); }
  }
  for (const p of out.resolved ?? []) {
    const x = state.items.find((i) => i.permalink === p);
    if (x && !x.ticked) { Object.assign(x, { ticked: true, tickedAt: now, by: "sweep" }); logHandled(state, x, now); }
  }
  // Ticked a week ago: forget it, and don't let a later sweep bring it back.
  for (const x of state.items.filter((i) => i.ticked && now - i.tickedAt > 7 * 86_400_000)) state.dismissed.push(x.permalink);
  state.items = state.items.filter((i) => !state.dismissed.includes(i.permalink));
  state.dismissed = state.dismissed.slice(-500);
  state.lastAt = now;
  return fresh;
}

// Asks you handled (ticked, or replied to so the sweep resolved them), kept for the standup even after Clear.
// Skipped asks and FYIs stay out. Two weeks are kept.
function logHandled(state, x, now) {
  if (x.kind !== "ask") return;
  state.handled = [...(state.handled ?? []).filter((h) => h.permalink !== x.permalink && now - h.at < 14 * 86_400_000),
    { permalink: x.permalink, from: x.from, channel: x.channel, text: x.text, by: x.by, at: now }];
}
const unlog = (state, permalink) => { state.handled = (state.handled ?? []).filter((h) => h.permalink !== permalink); };

// Ticks, skips, undos and clears from the Inbox (shared "cc.slack.action").
export function apply(state, action, now) {
  const ids = new Set(action.ids ?? []);
  for (const x of state.items) {
    if (!ids.has(x.permalink)) continue;
    if (action.op === "tick") { Object.assign(x, { ticked: true, tickedAt: now, by: "you" }); logHandled(state, x, now); }
    if (action.op === "skip") { Object.assign(x, { ticked: true, tickedAt: now, by: "skipped" }); unlog(state, x.permalink); }
    if (action.op === "untick") { Object.assign(x, { ticked: false, tickedAt: null, by: null }); unlog(state, x.permalink); }
  }
  if (action.op === "clear") {
    for (const x of state.items.filter((i) => i.ticked)) state.dismissed.push(x.permalink);
    state.items = state.items.filter((i) => !i.ticked);
  }
}

// What the Inbox needs: open items, ticked today, and how the sweep is doing.
export function publish(state, status) {
  const today = new Date().setHours(0, 0, 0, 0);
  return {
    ...status,
    items: state.items.filter((i) => !i.ticked || i.tickedAt >= today),
    lastAt: state.lastAt,
  };
}
