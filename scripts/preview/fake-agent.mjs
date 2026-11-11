#!/usr/bin/env node
// A stand-in agent for scripts/preview.mjs: report a status and title to Herdr, draw a fixed screen, wait.
// Usage: fake-agent.mjs <screen file or -> <app or -> <status> [title]
// In the screen file, \e becomes ESC (colours: \e[2m dim) and {rule} a line across the pane. As in a real TUI,
// the screen is drawn again when the pane resizes, and a screen taller than the pane loses its top lines.
import { readFileSync } from "node:fs";

const [screen, app, status, title] = process.argv.slice(2);
const out = process.stdout;

if (app !== "-") out.write(`\x1b]7501;state=${status}:app=${app}\x07\x1b[?25l`); // OSC 7501: this is an agent, in this state
if (title) out.write(`\x1b]0;${title}\x07`);

const text = screen !== "-" ? readFileSync(screen, "utf8").replaceAll("\\e", "\x1b") : "";
const draw = () => {
  const cols = out.columns || 100, rows = out.rows || 40;
  const lines = text.replaceAll("{rule}", "─".repeat(cols)).replace(/\n+$/, "").split("\n");
  out.write("\x1b[?7l\x1b[H\x1b[2J" + lines.slice(-rows).join("\r\n"));
};
if (text) { draw(); out.on("resize", draw); }
setInterval(() => {}, 1 << 30);
