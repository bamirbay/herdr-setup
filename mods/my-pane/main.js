// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "my-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.
// Mine: on the right, the branch's Linear issue and PR (from the work mod's poll: CI ✓ ✗ •, review), each a link.
// Close parks a sub-agent and never closes a space's last pane, like cmd-w.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, spaces, terminals, props, run, exec, theme, home, shared } from "herdr";

const LINEAR = "https://linear.app/tryprofound/issue/"; // setting: your Linear workspace
const issueKey = (branch) => /^([a-z]+-\d+)(?:-|$)/i.exec((branch ?? "").replace(/^[^/]+\//, ""))?.[1]?.toUpperCase() ?? null;
async function openLinear(url) {
  const r = await exec("open", ["-a", "Linear", url]).catch(() => null);
  if (r?.code !== 0) await exec("open", [url]);
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/my-pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .children(this.links(t, p))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .when(this.closable(p), el => el.child(this.closeButton(t, p))));
  }

  // The branch's issue key and PR, each opening on click.
  links(t, p) {
    const branch = p.branch, key = issueKey(branch);
    const all = shared("work.prs"), pr = branch && !/^(main|master)$/.test(branch) ? [...(all?.open ?? []), ...(all?.merged ?? [])].find((x) => x.branch === branch) : null;
    const link = (id, label, color, open) => div().id(id).flex_none().px(5).h(18).flex().items_center().rounded(4).border_1().border_color(t.border)
      .text_size(11).text_color(color).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); open(); }).child(label);
    const out = [];
    if (key) out.push(link(`ph-issue-${p.pane}`, key, t.muted, () => openLinear((shared("work.issues")?.issues ?? []).find((i) => i.identifier === key)?.url ?? LINEAR + key)));
    if (pr) {
      const failed = pr.ci === "FAILURE" || pr.ci === "ERROR", open = pr.state === "OPEN";
      const ci = !open || !pr.ci ? "" : pr.ci === "SUCCESS" ? " ✓" : failed ? " ✗" : " •";
      const label = open ? `#${pr.number}${ci}${pr.review === "APPROVED" ? " approved" : pr.review === "CHANGES_REQUESTED" ? " changes requested" : ""}` : `#${pr.number} ${pr.state.toLowerCase()}`;
      const color = open && (failed || pr.review === "CHANGES_REQUESTED") ? "#f85149" : open && pr.review === "APPROVED" ? "#3fb950" : t.muted;
      out.push(link(`ph-pr-${p.pane}`, label, color, () => { exec("open", [pr.url]).catch(() => null); }));
    }
    return out;
  }

  // Not the space's last pane, unless it's a sub-agent (that one goes back under its parent).
  closable(p) {
    if (terminals().find((k) => k.address === p.terminal)?.parent) return true;
    const space = spaces().find((s) => s.tabs.some((x) => x.id === p.tab)), tabs = new Set((space?.tabs ?? []).map((x) => x.id));
    return panes().filter((x) => tabs.has(x.tab)).length > 1;
  }

  closeButton(t, p) {
    const sub = terminals().find((k) => k.address === p.terminal && k.state === "live")?.parent;
    return sub ? this.button(t, `ph-x-${p.pane}`, "close", "terminal.park", { terminal: p.terminal }) : this.button(t, `ph-x-${p.pane}`, "close", "pane.close", { pane: p.pane });
  }
}
