// Your assigned Jira issues, grouped by status, alongside Linear: each row links
// to the space and tab working on it (by branch name carrying the issue key).
// Issues come from cc-status (shared "cc.jira"); this panel only asks for a refresh.
// Enabled but unconfigured shows the setup hint, never an empty tab. Start
// opens cc-start with the issue; move-to-started stays Linear-only (gated in cc-start).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, shared, setShared, theme, run, exec, openOverlay } from "herdr";
import { isProviderEnabled, isProviderConfigured, filterBySource, setupHint } from "../cc-status/providers.js";

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

// Any branch that carries the issue key (eng-412-…).
export function linkOf(issue, allPanes, allSpaces) {
  const id = (issue.identifier ?? "").toLowerCase();
  if (!id) return null;
  const pane = allPanes.find((p) => p.branch && p.branch.toLowerCase().includes(id));
  if (!pane) return null;
  const space = allSpaces.find((s) => s.tabs.some((t) => t.id === pane.tab));
  const tab = space?.tabs.find((t) => t.id === pane.tab);
  return space && tab ? { space, tab, branch: pane.branch } : null;
}

export default class Jira extends View {
  init(_props, cx) {
    cx.timer.every(60_000, (cx) => cx.notify());
    // First look, or a failure a while ago: check once (the schedule covers the rest).
    const s = shared("cc.settings"), data = shared("cc.jira") ?? {};
    if (s && isProviderEnabled(s, "jira") && isProviderConfigured(s, "jira")
      && !data.running && (!data.at || (data.error && Date.now() - data.at > 5 * 60_000)) && !data.notConfigured)
      setShared("cc.trackers.request", Date.now());
  }

  // Off in settings, or the tracker isn't configured: a message with what to do, instead of an empty list.
  notice(t, data) {
    const s = shared("cc.settings") ?? {};
    const save = (p) => setShared("cc.settings.update", { patch: p, at: Date.now() });
    const button = (id, label, primary, action) => div().id(id).px(12).py(5).rounded(6).text_size(12).font_medium().border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((x) => x.opacity(0.85)).on_click(() => action()).child(label);
    if (!isProviderEnabled(s, "jira")) return v_flex().p(24).gap(10).items_center()
      .child(div().text_color(t.muted).child("Jira is off"))
      .child(button("jira-on", "Turn it on", true, () => save({ trackers: {
        issues: [...new Set([...(s.trackers?.issues ?? []), "jira"])],
        jira: { ...(s.trackers?.jira ?? {}), enabled: true } } })));
    if (isProviderConfigured(s, "jira") && !data.notConfigured) return null;
    const hint = setupHint("jira");
    return v_flex().p(20).gap(10)
      .child(div().font_semibold().child(hint.title))
      .child(div().text_size(12.5).text_color(t.muted).child(hint.body))
      .child(h_flex().gap(8).pt(4)
        .child(button("jira-check", data.running ? "Checking…" : "Check again", true, () => !data.running && setShared("cc.trackers.request", Date.now())))
        .child(button("jira-off", "I don't use Jira", false, () => save({ trackers: {
          issues: (s.trackers?.issues ?? []).filter((x) => x !== "jira"),
          jira: { ...(s.trackers?.jira ?? {}), enabled: false } } }))));
  }

  render() {
    const t = theme();
    const data = shared("cc.jira") ?? {};
    const allPanes = panes(), allSpaces = spaces();
    const issues = filterBySource(data.issues, "jira").sort((a, b) => (b.updated ?? "") < (a.updated ?? "") ? -1 : 1);
    const groups = [];
    for (const i of issues) {
      const g = groups.find((x) => x.name === (i.state || "No status"));
      if (g) g.items.push(i); else groups.push({ name: i.state || "No status", items: [i] });
    }
    const stop = (_e, cx) => cx.stop_propagation();

    const dot = (status) => status === "working"
      ? div().size(9).rounded(5).border_2().border_color(t.working)
      : div().size(8).rounded(4).bg(status ? t[status] : t.dim);

    const button = (id, label, primary, action) => div().id(id).flex_none().px(9).py(3).rounded(5).text_size(11.5).font_medium().border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((x) => x.opacity(0.85)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(label);

    const row = (i) => {
      const link = linkOf(i, allPanes, allSpaces);
      const open = () => link ? (run("space.select", { id: link.space.id }), run("tab.select", { id: link.tab.id })) : exec("open", [i.url]);
      return v_flex().id(`ji-${i.identifier}`).w_full().px(14).py(8).gap(5).hover((x) => x.bg(t.hover)).on_click(() => open())
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().text_size(11).text_color(t.dim).child(i.identifier))
          .child(div().flex_1().min_w(0).truncate().font_medium().child(i.title))
          .when(!link, (el) => el.child(button(`start-${i.identifier}`, "Start", true,
            () => openOverlay({ mod: "cc-start", kind: "dialog", width: 640, props: { issue: i } }))))
          .when(Boolean(link), (el) => el.child(button(`open-${i.identifier}`, "Jira", false, () => exec("open", [i.url])))))
        .when(Boolean(link), (el) => el.child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.muted)
          .child(dot(link.tab.status))
          .child(div().flex_1().min_w(0).truncate().child(`${link.space.name} › ${link.tab.name}${link.tab.status ? ` · ${link.tab.status === "blocked" ? "needs you" : link.tab.status}` : ""}`))));
    };

    const section = (g) => ([
      h_flex().id(`jg-${g.name}`).px(14).pt(10).pb(4).gap(8).items_center().text_size(11.5)
        .child(div().font_semibold().text_color(t.foreground).child(g.name))
        .child(div().text_color(t.dim).child(String(g.items.length))),
      ...g.items.map(row),
    ]);

    const sync = data.running ? "checking…" : data.at ? ago(data.at) : "";
    const notice = this.notice(t, data);
    const refresh = () => setShared("cc.trackers.request", Date.now());

    return v_flex().id("cc-jira").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("My Jira issues"))
        .child(div().text_size(11).text_color(t.dim).child(issues.length ? String(issues.length) : ""))
        .child(div().flex_1())
        .child(div().id("cc-jira-refresh").text_size(11).text_color(t.dim).hover((x) => x.text_color(t.foreground))
          .on_click(() => refresh()).child(sync ? `${sync} · refresh` : "refresh")))
      .when(Boolean(notice), (el) => el.child(notice))
      .when(!notice && Boolean(data.error), (el) => el.child(v_flex().flex_none().px(14).py(8).gap(2).bg(t.raised).border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.blocked).child(`Couldn't read Jira: ${data.error}`))
        .child(div().text_size(11.5).text_color(t.dim).child("Click refresh to try again."))))
      .when(!notice, (el) => el.child(v_flex().id("cc-jira-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(groups.flatMap(section))
        .when(groups.length === 0, (el) => el.child(div().p(24).text_center().text_color(t.dim)
          .child(data.running ? "Loading your issues…" : data.at ? "No Jira issues assigned to you in the last day" : "Not loaded yet")))));
  }
}
