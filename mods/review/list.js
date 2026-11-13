// The right sidebar: the focused terminal's changed files (a review tab's terminal while one is focused), the
// Branch / Uncommitted / Since sent switch, and commit. Clicking a file opens that terminal's review tab at the file.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, shared, setShared, theme } from "herdr";
import { mode, target, key, openTab } from "./state.js";
import { C, STATUS } from "./git.js";
import { RepoView } from "./repo.js";

export class ReviewList extends RepoView {
  constructor(cx) {
    super(cx);
    this.message = "";
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
  }

  reset() { this.message = ""; this.input?.set_value(""); }
  onKey(e) { if (e.key !== "escape" || !this.typing) return false; this.typing = false; this.handle.focus(); return true; }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = "commit"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.say("note", `Commit failed: ${e.message ?? e}`); }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  render(cx) {
    this.catchUp(cx);
    const t = theme();
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const openPath = (shared("review.open") ?? {})[target().terminal]?.path;
    const perFile = {};
    for (const c of this.comments()) perFile[c.path] = (perFile[c.path] ?? 0) + 1;
    const modeButton = (id, label) => div().id(`mode-${id}`).px(6).py(1).rounded(4).text_size(10.5).cursor_pointer()
      .when(mode() === id, (e) => e.bg(t.selected).text_color(t.foreground))
      .when(mode() !== id, (e) => e.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
      .on_click(() => setShared("review.mode", id)).child(label);
    const empty = this.error || (this.loading ? "Loading changes…" : this.root ? ({ branch: "No changes on this branch", uncommitted: "No uncommitted changes", sent: "No changes since your last send" }[mode()]) : "No folder");
    return this.notes(this.frame(t, cx)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Review"))
        .child(h_flex().gap(2).child(modeButton("branch", "Branch")).child(modeButton("uncommitted", "Uncommitted")).child(modeButton("sent", "Since sent").tooltip("Only what changed after your last Send")))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(C.green).child(`+${add}`)).child(div().text_size(11).text_color(C.red).child(`−${del}`)))
      .when(Boolean(this.baseNote), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(this.baseNote)))
      .when(mode() === "branch" && Boolean(this.baseName), (e) => e.child(div().px(14).pt(6).text_size(10.5).text_color(t.dim).child(`vs ${this.baseName}`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).when(this.switching(), (e) => e.opacity(0.55)).children(this.files.map((f) => {
          const parts = f.path.split("/"), name = parts.pop();
          return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
            .when(openPath === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click(() => openTab(f.path))
            .child(div().w(14).text_size(11).font_semibold().text_color(STATUS[f.status] ?? t.dim).child(f.status))
            .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
            .when(Boolean(perFile[f.path]), (e) => e.child(div().px(4).rounded(4).bg(C.comment).text_size(10.5).text_color(t.foreground).child(`${perFile[f.path]} ›`)))
            .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(C.green).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(C.red).child(`−${f.del}`)));
        })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12)
          .when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy === "commit" ? "Committing…" : "Commit"))), t);
  }
}
