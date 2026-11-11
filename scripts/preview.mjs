#!/usr/bin/env node
// Opens Command Center in its own Herdr window filled with scripts/preview/demo.json, saves preview.png (Inbox) and
// docs/board.png (Board with Tasks), then closes the window and deletes everything it made.
//
// The window has its own app home, HOME and herdr-core, so it never sees or changes your spaces, logins, caches
// or agents. Settings "demo": true stops all fetching: no gh, no Claude runs. Modeled on Bettr's scripts/preview.py.
//   node scripts/preview.mjs           make both screenshots
//   node scripts/preview.mjs --keep    leave the window open (Ctrl-C to clean up)

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, patch } from "../mods/cc-status/settings.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEMO = JSON.parse(readFileSync(join(ROOT, "scripts/preview/demo.json"), "utf8"));
const FAKE_AGENT = join(ROOT, "scripts/preview/fake-agent.mjs");
const keep = process.argv.includes("--keep");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tool = (name) => realpathSync(execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim());

const herdrApp = tool("herdr-app"), hc = tool("hc");
// A short folder: macOS limits a socket path to about 100 characters.
const base = realpathSync(mkdtempSync("/tmp/cc-"));
// The app home sits in the fake HOME, where it normally lives: Herdr lets mods read files only inside HOME.
const home = join(base, "home"), app = join(home, ".config/herdr-app");
// A clean environment: a fake HOME (no logins, ssh hosts or shell config of yours) and this window's app home.
const env = { PATH: `${home}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, SHELL: "/bin/zsh",
  TERM: "xterm-256color", LANG: "en_US.UTF-8", HERDR_APP_HOME: app };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const herdr = (command, args = {}) => JSON.parse(run(herdrApp, ["do", command, JSON.stringify(args)]) || "{}");
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2)); };
const git = (cwd, ...args) => run("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "-c", "init.defaultBranch=main", ...args], { cwd });

let window = null;

function prepare() {
  mkdirSync(app, { recursive: true });
  execFileSync(process.execPath, [join(ROOT, "install.mjs")], { env: { ...process.env, HERDR_APP_HOME: app }, stdio: "ignore" });
  write(join(app, "command-center.json"), patch(DEFAULTS, DEMO.settings));
  write(join(app, "command-center-demo.json"), { shared: DEMO.shared, standup: DEMO.standup });
  const version = run(herdrApp, ["--version"]).trim().split(/\s+/).pop();
  write(join(app, "settings.json"), { core: hc, telemetry: false, sounds: { enabled: false }, appearance: "dark" });
  write(join(app, "window.json"), { state: "windowed", bounds: [40, 40, DEMO.window.width, DEMO.window.height] });
  write(join(app, "shared.json"), { layout: "command-center", "frame.welcomed": "finished" });
  write(join(app, "update-notes.json"), { last_run: version, presented: [version] });
  write(join(home, ".zshrc"), "PROMPT='%~ %# '\n");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  for (const name of ["herdr-core", "hc"]) symlinkSync(hc, join(home, ".local/bin", name));
}

// One git repo per space on its branch, with uncommitted changes for the Tasks panel; a tab on another
// branch gets a worktree beside it. Returns each tab's folder.
function repos() {
  const folders = {};
  for (const space of DEMO.spaces) {
    const dir = join(home, "code", space.name);
    mkdirSync(dir, { recursive: true });
    write(join(dir, "README.md"), `# ${space.name}\n`);
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "Initial commit");
    if (space.branch !== "main") git(dir, "checkout", "-qb", space.branch);
    // The branch's work as two commits, so Tasks shows changed files and a commit count.
    const files = Object.entries(space.dirty ?? {});
    files.forEach(([file, lines], n) => {
      write(join(dir, file), Array.from({ length: lines }, (_, i) => `// line ${i + 1}\n`).join(""));
      if (n === 0 || n === files.length - 1) { git(dir, "add", "."); git(dir, "commit", "-qm", `Work on ${space.branch} (${n + 1})`); }
    });
    for (const [key, s] of Object.entries(DEMO.summaries[space.name] ?? {})) {
      const { updatedAgo, ...summary } = s;
      write(join(dir, ".agents/tasks/.summary", `${key}.json`), { ...summary, updatedAt: Date.now() - updatedAgo * 1000 });
      write(join(dir, ".agents/tasks", `${key}.md`), `# ${key}: ${s.title}\n\n## Goal\n${s.goal}\n`);
    }
    for (const tab of space.tabs) {
      folders[`${space.name}/${tab.name}`] = dir;
      if (!tab.branch) continue;
      const wt = join(home, "code", `${space.name}-${tab.branch}`);
      git(dir, "worktree", "add", "-q", "-b", tab.branch, wt);
      folders[`${space.name}/${tab.name}`] = wt;
    }
  }
  return folders;
}

function start() {
  const log = openSync(join(base, "app.log"), "a");
  window = spawn(herdrApp, [], { env, stdio: ["ignore", log, log], detached: true });
  for (let i = 0; i < 60; i++) {
    try { run(herdrApp, ["status"]); return; } catch { sleep(500); }
  }
  throw new Error(`the preview window did not start; see ${join(base, "app.log")}`);
}

// Herdr's toasts (an agent finished) would cover the panels: in this window, close each one at once.
function muteToasts() {
  write(join(app, "mods/toast/main.js"), 'import { View, div } from "gpui-kit";\nimport { closeOverlay, props } from "herdr";\n\n'
    + "export default class Toast extends View {\n  init() { closeOverlay(props()?.overlay); }\n  render() { return div(); }\n}\n");
}

function fill(folders) {
  let focus = null;
  for (const space of DEMO.spaces) {
    let spaceId = null;
    for (const tab of space.tabs) {
      const folder = folders[`${space.name}/${tab.name}`];
      const p = tab.panes[0];
      const argv = p.argv ?? [process.execPath, FAKE_AGENT, join(ROOT, "scripts/preview/screens", p.screen), p.app, p.status, p.title ?? ""];
      const made = spaceId === null
        ? herdr("space.new", { name: space.name, folder, tab: tab.name, argv })
        : herdr("tab.new", { name: tab.name, space: spaceId, folder, argv });
      spaceId ??= made.space;
      if (p.focus) focus = made.terminal;
    }
  }
  return focus;
}

function shot(file) {
  mkdirSync(dirname(file), { recursive: true });
  run(herdrApp, ["shot", file]);
  execFileSync("/usr/bin/sips", ["-Z", String(DEMO.window.width), file, "--out", file], { stdio: "ignore" });
  console.log(`saved ${file.replace(`${ROOT}/`, "")}`);
}

function stop() {
  try { run(herdrApp, ["do", "app.quit"]); } catch { /* already gone */ }
  sleep(1500);
  try { process.kill(-window.pid); } catch { /* already gone */ }
  try { run(hc, ["server", "stop"]); } catch { /* not running */ }
  rmSync(base, { recursive: true, force: true });
}

process.on("SIGINT", () => { stop(); process.exit(130); });
try {
  prepare();
  const folders = repos();
  start();
  muteToasts();
  const focus = fill(folders);
  if (focus) herdr("pane.focus", { terminal: focus });
  sleep(4000); // mods load the demo data and read the blocked agent's question
  shot(join(ROOT, "preview.png"));
  herdr("layout.select", { stack: "center", child: "board" });
  herdr("layout.select", { stack: "panel-body", child: "tasks" });
  sleep(2500);
  shot(join(ROOT, "docs/board.png"));
  if (keep) { console.log("The window stays open; press Ctrl-C to close it and clean up."); setInterval(() => {}, 1 << 30); }
  else stop();
} catch (e) {
  console.error(String(e?.stderr || e?.message || e));
  stop();
  process.exit(1);
}
