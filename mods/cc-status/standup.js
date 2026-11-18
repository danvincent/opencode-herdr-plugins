// Standup draft ("What did you accomplish?"): local facts (commits, PRs, task summaries) gathered here,
// Linear and your own Slack messages read by one headless Sonnet run, which writes the text.
//
// The testable logic (windowFor, gatherLocal, standupPrompt, STANDUP_TOOLS)
// lives in ./local.js with no Herdr runtime imports; this module re-exports
// it wired to the real herdr fns and keeps the draft-editing helpers.

import { exec, readTextFile, shared, home, appHome } from "herdr";
import {
  STANDUP_TIMEOUT as LOCAL_TIMEOUT,
  windowFor, standupSlot, STANDUP_TOOLS,
  gatherLocal as gatherLocalPure, standupPrompt,
} from "./local.js";

export { windowFor, standupSlot, STANDUP_TOOLS, standupPrompt };
export const STANDUP_TIMEOUT = LOCAL_TIMEOUT;

// Herdr-wired gatherLocal: the real exec/fs/shared/home/appHome, overridable
// per-call via deps (REST fetch/getEnv already are). Tests import local.js.
export const gatherLocal = (win, settings = null, deps = {}) =>
  gatherLocalPure(win, settings, { exec, readTextFile, shared, home, appHome, ...deps });

export const STANDUP_SCHEMA = JSON.stringify({ type: "object", required: ["text", "error"], properties: { text: { type: "string" }, error: { type: "string" } } });

// The draft as bullets you can edit, remove, reorder and ask about; text is what Copy puts on the clipboard.
let seq = 0;
const newId = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;
export const toBullets = (text) => (text ?? "").split("\n")
  .map((l) => l.replace(/^\s*[-*•]\s+/, "").trim()).filter(Boolean).map((t) => ({ id: newId(), text: t }));
export const toText = (bullets) => (bullets ?? []).map((b) => `- ${b.text}`).join("\n");

// Keeps the last 10 versions for Undo.
export function remember(state) {
  state.history = [...(state.history ?? []), (state.bullets ?? []).map((b) => ({ ...b }))].slice(-10);
}

export function applyEdit(state, a) {
  if (a.op === "undo") {
    const prev = state.history?.pop();
    if (prev) state.bullets = prev;
    return;
  }
  remember(state);
  const b = state.bullets ?? [];
  const i = b.findIndex((x) => x.id === a.id);
  if (a.op === "set" && i >= 0) { if (a.text.trim()) b[i].text = a.text.trim(); else b.splice(i, 1); }
  if (a.op === "remove" && i >= 0) b.splice(i, 1);
  if (a.op === "add" && a.text?.trim()) b.push({ id: newId(), text: a.text.trim() });
  if (a.op === "move") {
    const to = b.findIndex((x) => x.id === a.to);
    if (i >= 0 && to >= 0 && i !== to) b.splice(to, 0, ...b.splice(i, 1));
  }
  state.bullets = b;
  state.edited = true;
}

export const ASK_SCHEMA = JSON.stringify({ type: "object", required: ["bullets"], properties: { bullets: { type: "array", items: { type: "string" } } } });

// One bullet (id) or the whole draft, changed as asked; returns bullets without leading dashes.
export function askPrompt(state, instruction, id) {
  const list = (state.bullets ?? []).map((b, n) => `${n + 1}. ${b.text}`).join("\n");
  const n = (state.bullets ?? []).findIndex((b) => b.id === id);
  const style = "One line each, outcome first, plain direct sentences, no filler or hype. Keep Linear IDs and PR numbers.";
  return n >= 0
    ? `My standup draft for ${state.label} ("What did you accomplish?"):\n${list}\n\nChange only bullet ${n + 1}: ${instruction}\n${style}\nReturn bullets: the new text for bullet ${n + 1} alone (two items if I asked to split it, none if I asked to drop it). No leading dash.`
    : `My standup draft for ${state.label} ("What did you accomplish?"):\n${list}\n\nChange it: ${instruction}\n${style}\nKeep bullets my request doesn't touch word for word, in their order. Return the whole list as bullets, no leading dash.`;
}

// Bullets after an ask: the whole list, or the asked bullet replaced by what came back.
export function applyAsk(state, id, out) {
  remember(state);
  const fresh = out.map((t) => ({ id: newId(), text: t.replace(/^\s*[-*•]\s+/, "").trim() })).filter((b) => b.text);
  const i = (state.bullets ?? []).findIndex((b) => b.id === id);
  if (id && i >= 0) state.bullets.splice(i, 1, ...fresh);
  else state.bullets = fresh;
  state.edited = true;
}
