// Bitbucket pull requests, alongside the GitHub views: open PRs from the
// Bitbucket REST list (MCP-first lives in the standup headless prompt).
// Issues come from cc-status (shared "cc.bitbucket"); this panel only asks for
// a refresh. Enabled but unconfigured shows the setup hint, never an empty tab.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { shared, setShared, theme, exec } from "herdr";
import { isProviderEnabled, isProviderConfigured, filterBySource, setupHint } from "../cc-status/providers.js";

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export default class Bitbucket extends View {
  init(_props, cx) {
    cx.timer.every(60_000, (cx) => cx.notify());
    // First look, or a failure a while ago: check once (the schedule covers the rest).
    const s = shared("cc.settings"), data = shared("cc.bitbucket") ?? {};
    if (s && isProviderEnabled(s, "bitbucket") && isProviderConfigured(s, "bitbucket")
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
    if (!isProviderEnabled(s, "bitbucket")) return v_flex().p(24).gap(10).items_center()
      .child(div().text_color(t.muted).child("Bitbucket is off"))
      .child(button("bb-on", "Turn it on", true, () => save({ trackers: {
        repositories: [...new Set([...(s.trackers?.repositories ?? []), "bitbucket"])],
        bitbucket: { ...(s.trackers?.bitbucket ?? {}), enabled: true } } })));
    if (isProviderConfigured(s, "bitbucket") && !data.notConfigured) return null;
    const hint = setupHint("bitbucket");
    return v_flex().p(20).gap(10)
      .child(div().font_semibold().child(hint.title))
      .child(div().text_size(12.5).text_color(t.muted).child(hint.body))
      .child(h_flex().gap(8).pt(4)
        .child(button("bb-check", data.running ? "Checking…" : "Check again", true, () => !data.running && setShared("cc.trackers.request", Date.now())))
        .child(button("bb-off", "I don't use Bitbucket", false, () => save({ trackers: {
          repositories: (s.trackers?.repositories ?? []).filter((x) => x !== "bitbucket"),
          bitbucket: { ...(s.trackers?.bitbucket ?? {}), enabled: false } } }))));
  }

  render() {
    const t = theme();
    const data = shared("cc.bitbucket") ?? {};
    const prs = filterBySource(data.prs, "bitbucket")
      .sort((a, b) => ((b.state === "open") - (a.state === "open")) || (Date.parse(b.updated ?? 0) - Date.parse(a.updated ?? 0)));
    const stop = (_e, cx) => cx.stop_propagation();

    const button = (id, label, primary, action) => div().id(id).flex_none().px(9).py(3).rounded(5).text_size(11.5).font_medium().border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((x) => x.opacity(0.85)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(label);

    const row = (p) => v_flex().id(`bb-${p.number}`).w_full().px(14).py(8).gap(5).hover((x) => x.bg(t.hover)).on_click(() => exec("open", [p.url]))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${p.number}`))
        .child(div().flex_1().min_w(0).truncate().font_medium().child(p.title))
        .child(button(`open-${p.number}`, "Open", false, () => exec("open", [p.url]))))
      .child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate()
          .child([p.repo, p.draft ? "draft" : p.state, p.updated ? `updated ${ago(Date.parse(p.updated))}` : null].filter(Boolean).join(" · "))));

    const sync = data.running ? "checking…" : data.at ? ago(data.at) : "";
    const notice = this.notice(t, data);
    const refresh = () => setShared("cc.trackers.request", Date.now());

    return v_flex().id("cc-bitbucket").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Bitbucket PRs"))
        .child(div().text_size(11).text_color(t.dim).child(prs.length ? String(prs.length) : ""))
        .child(div().flex_1())
        .child(div().id("cc-bitbucket-refresh").text_size(11).text_color(t.dim).hover((x) => x.text_color(t.foreground))
          .on_click(() => refresh()).child(sync ? `${sync} · refresh` : "refresh")))
      .when(Boolean(notice), (el) => el.child(notice))
      .when(!notice && Boolean(data.error), (el) => el.child(v_flex().flex_none().px(14).py(8).gap(2).bg(t.raised).border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.blocked).child(`Couldn't read Bitbucket: ${data.error}`))
        .child(div().text_size(11.5).text_color(t.dim).child("Click refresh to try again."))))
      .when(!notice, (el) => el.child(v_flex().id("cc-bitbucket-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(prs.map(row))
        .when(prs.length === 0, (el) => el.child(div().p(24).text_center().text_color(t.dim)
          .child(data.running ? "Loading pull requests…" : data.at ? "No Bitbucket pull requests in the window" : "Not loaded yet")))));
  }
}
