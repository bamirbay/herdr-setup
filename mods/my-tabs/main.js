import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, terminals, focused, run, openOverlay, theme, window, shared, layout, settings, nextCommand, notify } from "herdr";

// cmd-w / cmd-shift-w (keys.json "layout:my-main"; the tab bar is always on screen, so its commands always arrive): a sub-agent's pane is parked, so it keeps running under its
// parent; any other pane closes, except a space's last one: spaces close by hand.
function closePane() {
  const f = focused();
  if (!f?.pane) return;
  const term = f.terminal && terminals().find((k) => k.address === f.terminal);
  if (term?.parent && term.state === "live") { run("terminal.park", { terminal: term.address }); return; }
  const space = spaces().find((s) => s.id === f.space), tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  if (panes().filter((p) => tabs.has(p.tab)).length <= 1) { notify({ title: "Spaces close by hand", body: "This is the space's last pane.", level: "info" }); return; }
  run("pane.close", { pane: f.pane });
}

// cmd-shift-s: the focused agent's newest sub-agent without a pane, opened to the right of the focused pane.
function beside() {
  const me = focused()?.terminal, shown = new Set(panes().map((p) => p.terminal));
  // shortcut: addresses count up in base 36 (t9, ta, …, t1j), so the highest is the newest; use a start time if hc ls gets one.
  const n = (a) => parseInt(a.replace(/^.*\//, "").slice(1), 36);
  const kid = terminals().filter((k) => me && k.parent === me && k.state === "live" && !shown.has(k.address)).sort((a, b) => n(b.address) - n(a.address))[0];
  if (kid) run("terminal.keep", { terminal: kid.address, place: "right" });
  else notify({ title: "No sub-agent to open", body: "The focused agent has no running sub-agent without a pane.", level: "info" });
}
if (parseInt("1j", 36) <= parseInt("z", 36)) throw new Error("my-tabs self-check failed");

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The right panel's panes (files, changes, prs, linear): the buttons, cmd-shift-i / cmd-shift-l and the work badge
// toggle one (again while it shows: hide the panel); a PR alert's click only shows the PR pane.
const showing = (id) => { const root = layout(); return !find(root, "panel")?.hidden && find(root, "panel-body")?.active === id; };
function showPanel(id) { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
function togglePanel(id) { if (showing(id)) run("layout.hide", { id: "panel" }); else showPanel(id); }

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    cx.spawn(async (cx) => {
      for (;;) {
        const command = (await nextCommand()).split(/[.:]/).pop();
        try {
          if (command === "close") closePane();
          if (command === "beside") beside();
          if (command === "prs" || command === "linear") togglePanel(command);
          if (command === "showprs") showPanel("prs");
        } catch (e) {
          notify({ title: `${command} failed`, body: String(e?.message ?? e).slice(0, 300), level: "error" });
        }
        cx.notify();
      }
    });
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        // No ✕ on a space's only tab: closing it would close the space, and spaces close by hand.
        .when(c.active && shown.length > 1, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // PRs and Linear (the work mod's panes) are always on.
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "prs", "linear"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon, dot = false) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => togglePanel(id)).child(svg(icon).size(14)).child(label)
        .when(dot, el => el.child(div().size(6).rounded(3).bg("#f85149")));
    };
    // The red dot: some open PR needs you (the work badge decides and stores it).
    const needsYou = shared("work.needsYou") === true;
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .child(panelButton("prs", "PRs", "mods/my-tabs/pr.svg", needsYou))
      .child(panelButton("linear", "Linear", "mods/my-tabs/linear.svg"))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/my-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/my-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/my-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
