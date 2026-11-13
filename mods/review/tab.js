// A review tab, tied to one terminal (props.agent): every changed file's diff in one scroll, a header per file (sticky
// at the top), line comments sent to that agent, Viewed (cmd-e) and only-this-file (cmd-shift-e). Read-only while the
// terminal runs no agent.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { panes, exec, hc, run, settings, shared, theme } from "herdr";
import { mode, tied, target, key, prFor, viewedOf, setViewed, setComments } from "./state.js";
import { C, STATUS, anchor, message, loadDiffs } from "./git.js";
import { RepoView } from "./repo.js";

const ROW = 20, HEAD = 36; // a file header is a 6px gap plus a 30px bar
const TONE = { bad: C.red, good: C.green };

export class ReviewTab extends RepoView {
  constructor(cx) {
    super(cx);
    this.scroll = VirtualListScrollHandle.new();
    this.commentInput = InputState.new({ placeholder: "Comment · Enter saves · ⌘Enter saves and sends · Esc cancels" });
    this.commentInput.on("submit", (e, cx) => this.saveComment(cx, e?.secondary));
    // The sticky header follows the list's first visible row, which the list reports while drawing (no re-render there).
    cx.timer.every(150, (cx) => { if (this.visibleStart !== this.stickyAt) cx.notify(); });
  }

  reset() {
    Object.assign(this, { rows: [], auto: new Set(), fold: {}, only: null, sel: null, editing: null, sig: null, headers: null, memo: null, visibleStart: 0, cut: false });
  }

  async afterFiles(context) {
    const d = await loadDiffs({ root: this.root, on: this.on, files: this.files, hasHead: this.hasHead, against: this.against }, this.sig);
    if (!d || key() !== context) return;
    Object.assign(this, { sig: d.sig, rows: d.rows, auto: d.auto, cut: d.cut, sel: null, rowsVer: (this.rowsVer ?? 0) + 1 });
    this.headers = new Map(d.rows.filter((r) => r.kind === "file").map((r) => [r.path, r]));
    if (this.only && !this.headers.has(this.only)) this.only = null;
  }

  command(name, cx) {
    super.command(name);
    if (name === "comment") this.startComment(cx);
    if (name === "send") this.send(cx);
    if (name === "viewed") this.toggleViewed(cx);
    if (name === "only") this.toggleOnly(cx);
  }

  onEscape() { if (!this.editing) return false; this.editing = null; return true; }

  // Comments need an agent behind the tab; checked live, so starting Claude there turns them on.
  canComment() { return Boolean(panes().find((p) => p.terminal === tied())?.status); }

  viewed(path) { const h = this.headers?.get(path); return Boolean(h) && viewedOf(this.commentsKey)[path] === h.hash; }

  // Only-this-file folds the rest; otherwise a click decides, else viewed and bulky files start folded.
  folded(path) {
    if (this.only) return path !== this.only;
    return this.fold[path] ?? (this.viewed(path) || this.auto.has(path));
  }

  // The file at the top of the view (the sticky header's).
  currentPath() {
    const it = this.diffItems?.[this.visibleStart ?? 0];
    return it?.row?.path ?? it?.c?.path ?? this.rows[0]?.path ?? null;
  }

  // A header click: fold or unfold; in only-this-file, switch to that file.
  toggleFile(path) {
    if (this.only) { this.only = path; this.jump = path; } else this.fold[path] = !this.folded(path);
  }

  // cmd-e: mark the top file viewed (folds it, jumps to the next file), or unmark it.
  toggleViewed(cx) {
    const path = this.currentPath(), h = path && this.headers?.get(path);
    if (!h) return;
    const map = { ...viewedOf(this.commentsKey) }, was = map[path] === h.hash;
    if (was) delete map[path]; else map[path] = h.hash;
    delete this.fold[path];
    this.only = null;
    setViewed(this.commentsKey, map);
    const order = [...this.headers.keys()];
    this.jump = was ? path : order[order.indexOf(path) + 1] ?? path;
    cx.notify();
  }

  // cmd-shift-e: only the top file open; again: back to all files.
  toggleOnly(cx) {
    const path = this.only ?? this.currentPath();
    if (!path) return;
    this.only = this.only ? null : path;
    this.jump = path;
    cx.notify();
  }

  // Click picks a line, shift-click extends the selection within the same file.
  select(i, extend, cx) {
    const row = this.rows[i];
    if (row?.number === undefined) return;
    this.sel = extend && this.sel && this.rows[this.sel.a]?.path === row.path ? { ...this.sel, b: i } : { a: i, b: i };
    cx.notify();
  }

  selectedRows() {
    if (!this.sel) return [];
    const lo = Math.min(this.sel.a, this.sel.b), hi = Math.max(this.sel.a, this.sel.b), path = this.rows[this.sel.a]?.path;
    return this.rows.slice(lo, hi + 1).filter((r) => r.path === path && r.number !== undefined);
  }

  startComment(cx) {
    if (!this.canComment()) return;
    const rows = this.selectedRows();
    if (!rows.length) { this.say("note", "Select a line first: click it, shift-click for a range"); cx.notify(); return; }
    this.note = null; this.done = null;
    this.editing = { index: -1, path: rows[0].path, rows };
    this.commentInput.set_value("");
    this.commentInput.focus();
    cx.notify();
  }

  editComment(index, cx) {
    if (!this.canComment()) return;
    this.editing = { index };
    this.commentInput.set_value(this.comments()[index]?.text ?? "");
    this.commentInput.focus();
    cx.notify();
  }

  saveComment(cx, andSend) {
    const e = this.editing, text = this.commentInput.value().trim(), list = [...this.comments()];
    if (!e) return;
    if (e.index === -1 && text) {
      const last = e.rows.at(-1), quote = e.rows.find((r) => r.text.trim())?.text.trim().replace(/`/g, "'").slice(0, 80) ?? "";
      list.push({ path: e.path, at: anchor(e.path, e.rows), quote, text, end: { kind: last.kind, number: last.number } });
    } else if (e.index >= 0) {
      if (text) list[e.index] = { ...list[e.index], text }; else list.splice(e.index, 1);
    }
    setComments(this.commentsKey, list);
    this.editing = null; this.sel = null; this.handle.focus();
    if (andSend) this.send(cx);
    cx.notify();
  }

  deleteComment(index, cx) {
    const list = [...this.comments()];
    list.splice(index, 1); this.editing = null;
    setComments(this.commentsKey, list);
    cx.notify();
  }

  // Every comment on this repo in one message to the tab's agent, then back to that agent.
  // A blocked agent refuses it (hc send without --force).
  send(cx) {
    const list = this.comments();
    if (!list.length || this.busy) return;
    const pane = panes().find((p) => p.terminal === tied());
    if (!pane?.status) { this.say("note", `${tied()} isn't running an agent`); cx.notify(); return; }
    const ck = this.commentsKey;
    this.busy = "send"; this.note = null; this.done = null;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["send", pane.terminal, message(list)]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        setComments(ck, []);
        this.say("done", `Sent ${list.length} comment${list.length === 1 ? "" : "s"} to ${pane.program?.name ?? pane.terminal}`);
        run("tab.select", { id: pane.tab });
        run("pane.focus", { pane: pane.pane });
      } catch (e) { this.say("note", `Send failed: ${e.message ?? e}`); }
      finally { this.busy = false; cx.notify(); }
    });
    cx.notify();
  }

  // Rows are drawn inside the virtual list's layout, where handlers throw: clicks come through clickItem.
  diffRow({ kind, number, text }, selected, t) {
    if (kind === "@") return div().w_full().px(12).h(ROW).flex_none().truncate().bg(C.hunk).text_color(C.hunkText).child(text);
    const tint = kind === "+" ? C.add : kind === "-" ? C.del : null, gutter = kind === "+" ? C.addGutter : kind === "-" ? C.delGutter : null;
    return h_flex().w_full().h(ROW).flex_none()
      .when(Boolean(tint), (e) => e.bg(tint)).when(selected, (e) => e.bg(t.accent + "40"))
      .child(div().w(44).h_full().pr(8).flex_none().flex().items_center().justify_end().text_color(t.dim)
        .when(Boolean(gutter), (e) => e.bg(gutter).text_color(t.foreground)).child(number === undefined ? "" : String(number)))
      .child(div().w(16).flex_none().text_center().text_color(t.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // A file header: a gap, then a bar. `extra` (the sticky copy only: handlers can't go inside the list) ends the bar.
  fileRow({ path, file, size }, folded, t, extra) {
    const parts = path.split("/"), name = parts.pop(), viewed = this.viewed(path);
    return div().w_full().h(HEAD).flex_none().pt(6).bg(t.background).child(h_flex().w_full().h(HEAD - 6).pr(10).gap(8).items_center()
      .bg(t.raised).border_t(1).border_b(1).border_color(t.border).text_size(13).cursor_pointer()
      .child(div().w(3).h_full().flex_none().bg(viewed ? C.green : t.accent))
      .child(div().w(12).flex_none().text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(div().w(12).flex_none().font_semibold().text_color(STATUS[file.status] ?? t.dim).child(file.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().font_semibold().text_color(t.foreground).flex_none().child(name)))
      .when(folded && !viewed, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${size.toLocaleString()} lines · folded`)))
      .when(file.add > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(C.green).child(`+${file.add}`)))
      .when(file.del > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(C.red).child(`−${file.del}`)))
      .when(viewed && !extra, (e) => e.child(div().flex_none().px(6).rounded(4).bg(C.add).text_size(11).text_color(C.green).child("✓ Viewed")))
      .when(Boolean(extra), (e) => e.child(extra(viewed))));
  }

  commentRow(c, t) {
    return h_flex().w_full().h(ROW).flex_none().gap(6).pl(57).pr(8).items_center()
      .bg(C.comment).border_l(3).border_color(t.accent).text_color(t.foreground).font_family(settings().ui_font_family ?? "Geist")
      .child(div().flex_1().min_w(0).truncate().child(`› ${c.text}`));
  }

  // Click a file header to fold it; a line to select it, shift-click to extend, double-click to comment; a comment to edit it.
  clickItem(key, cx) {
    const index = Number(key.slice(1));
    if (key[0] === "h") { const path = this.rows[index]?.path; if (path) { this.toggleFile(path); cx.notify(); } return; }
    if (!this.canComment()) return;
    if (key[0] === "c") { this.editComment(index, cx); return; }
    const now = Date.now(), double = this.lastClick?.key === key && now - this.lastClick.at < 400;
    this.lastClick = { key, at: now };
    this.select(index, this.shift && !double, cx);
    if (double) this.startComment(cx);
  }

  // Header and rows per file (a folded file: its header only). A comment follows the line it ends on, else its
  // file's end (line gone or folded); comments on files no longer changed go last.
  items() {
    const comments = this.comments(), at = new Map(), placed = new Set(), out = [];
    const spot = (path, kind, number) => `${path}\0${kind}\0${number}`;
    comments.forEach((c, index) => { const k = spot(c.path, c.end?.kind, c.end?.number); at.set(k, [...(at.get(k) ?? []), { c, index }]); });
    const rest = (path) => comments.forEach((c, index) => { if (c.path === path && !placed.has(index)) { placed.add(index); out.push({ c, index }); } });
    const lo = this.sel ? Math.min(this.sel.a, this.sel.b) : -1, hi = this.sel ? Math.max(this.sel.a, this.sel.b) : -2;
    let path = null, folded = false;
    this.rows.forEach((row, i) => {
      if (row.kind === "file") {
        if (path !== null) rest(path);
        path = row.path; folded = this.folded(path);
        out.push({ row, i, folded });
      } else if (!folded) {
        out.push({ row, i, selected: i >= lo && i <= hi });
        for (const h of at.get(spot(row.path, row.kind, row.number)) ?? []) if (!placed.has(h.index)) { placed.add(h.index); out.push(h); }
      }
    });
    if (path !== null) rest(path);
    comments.forEach((c, index) => { if (!placed.has(index)) out.push({ c, index }); });
    return out;
  }

  // "top" only scrolls to the nearest edge. A header above the view lands at the top; for one at or below the top,
  // bring into view the row a screen further down, which leaves the header at the top (under its sticky copy).
  scrollToJump(cx) {
    const i = this.diffItems.findIndex((it) => it.row?.kind === "file" && it.row.path === this.jump);
    this.jump = null;
    if (i < 0) return;
    let j = i, h = this.sizes[i];
    if (i >= (this.visibleStart ?? 0)) while (j + 1 < this.sizes.length && h < (this.areaH ?? 0)) h += this.sizes[++j];
    this.scroll.scroll_to_item(j, "top");
    cx.timer.after(100, (cx) => cx.notify());
  }

  render(cx) {
    this.catchUp(cx);
    const t = theme();
    // A sidebar click sets review.open to {path, at}: unfold that file and scroll to its header, once per click.
    const want = (shared("review.open") ?? {})[tied()];
    if (want?.at && want.at !== this.jumped && this.headers?.has(want.path)) {
      this.jumped = want.at; this.jump = want.path;
      if (this.only) this.only = want.path; else this.fold[want.path] = false;
    }
    const can = this.canComment(), list = this.comments(), pr = prFor(target().branch), viewedMap = viewedOf(this.commentsKey);
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const viewedCount = [...(this.headers?.values() ?? [])].filter((h) => viewedMap[h.path] === h.hash).length;
    const editingAt = this.editing ? (this.editing.index >= 0 ? list[this.editing.index]?.at : anchor(this.editing.path, this.editing.rows)) : null;
    // The virtual list keeps its first callbacks, so they read this.diffItems (live), never a render-local list.
    // Rebuilt only when something it shows changed: wheel and timer re-renders (sticky header) stay cheap.
    const memo = JSON.stringify([this.rowsVer, this.fold, this.only, this.sel, list, viewedMap]);
    if (memo !== this.memo) {
      this.memo = memo;
      this.diffItems = this.items();
      this.sizes = this.diffItems.map((it) => (it.row?.kind === "file" ? HEAD : ROW));
    }
    if (this.jump) this.scrollToJump(cx);
    const itemKey = (i) => { const it = this.diffItems[i]; return !it ? `x${i}` : !it.row ? `c${it.index}` : `${it.row.kind === "file" ? "h" : "r"}${it.i}`; };
    const itemRow = (it) => (!it.row ? this.commentRow(it.c, theme()) : it.row.kind === "file" ? this.fileRow(it.row, it.folded, theme()) : this.diffRow(it.row, it.selected, theme()));
    // The list draws once to measure a row (a one-item range): only a real range moves the sticky header.
    const drawRange = (range) => { if (range.end - range.start > 1) this.visibleStart = range.start; return this.diffItems.slice(range.start, range.end).map(itemRow); };
    this.stickyAt = this.visibleStart;
    const stickyPath = this.diffItems.length ? this.currentPath() : null, sticky = stickyPath && this.headers?.get(stickyPath);
    const viewedBox = (viewed) => div().id("sticky-viewed").flex_none().px(8).h(22).flex().items_center().gap(4).rounded(5).border_1()
      .border_color(viewed ? C.green : t.border).bg(viewed ? C.add : t.background).text_size(11).text_color(viewed ? C.green : t.dim).cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleViewed(cx); }).child(viewed ? "✓ Viewed" : "Viewed ⌘E");
    const button = (id, label, on, action) => div().id(id).h(32).px(14).flex().items_center().rounded(8).bg(on ? t.solid : t.raised).text_color(on ? t.solid_foreground : t.dim).text_size(12).when(on, (e) => e.cursor_pointer()).on_click(action).child(label);
    return this.notes(this.frame(t, cx)
      // Any click gives the tab the keyboard, so cmd-e and the other review keys work (read-only tabs too).
      .on_mouse_down("left", () => this.handle.focus())
      .on_modifiers_changed((e) => { this.shift = e.modifiers.shift; })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().flex_none().child(`${this.files.length} file${this.files.length === 1 ? "" : "s"}`))
        .when(this.files.length > 0, (e) => e.child(div().text_size(11).text_color(viewedCount ? C.green : t.dim).child(`${viewedCount}/${this.files.length} viewed`)))
        .when(Boolean(this.only), (e) => e.child(div().id("only").px(6).py(1).rounded(4).bg(t.selected).text_size(11).cursor_pointer()
          .on_click((_e, cx) => this.toggleOnly(cx)).child("one file · ⌘⇧E for all")))
        .when(add > 0, (e) => e.child(div().text_size(11).text_color(C.green).child(`+${add}`)))
        .when(del > 0, (e) => e.child(div().text_size(11).text_color(C.red).child(`−${del}`)))
        .child(div().text_size(10.5).text_color(t.dim).child(mode() === "branch" ? `vs ${this.baseName ?? "origin/main"}` : "uncommitted"))
        .when(Boolean(pr), (e) => e.child(div().id("pr").px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11).text_color(TONE[pr.tone] ?? t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => { exec("open", [pr.url]).catch(() => null); }).child(pr.label ?? `#${pr.number}`)))
        .child(div().flex_1())
        .when(!can, (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child("read-only · not an agent")))
        .when(can && list.length > 0, (e) => e.child(div().id("send").h(26).px(10).flex().items_center().rounded(6).bg(this.busy ? t.raised : t.solid).text_color(this.busy ? t.dim : t.solid_foreground).text_size(12).cursor_pointer()
          .on_click((_e, cx) => this.send(cx)).child(this.busy === "send" ? "Sending…" : `Send ${list.length} ⌘↵`))))
      .when(Boolean(this.baseNote), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(this.baseNote)))
      .when(this.cut, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Over 50,000 diff lines: later files show their header only")))
      // No sideways scroll around the list: it took the wheel. Long lines are cut with "…".
      .child(div().id("diff-area").flex_1().min_h(0).min_w(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .on_scroll_wheel((_e, cx) => cx.notify()).on_size_change((size) => { this.areaH = size.height; })
        .child(v_virtual_list("changes-diff", this.diffItems.length, this.sizes, itemKey, drawRange)
          .track_scroll(this.scroll).size_full().on_item_click((key, cx) => this.clickItem(key, cx)))
        // Sticky header: a copy of the top file's header over the list; a click folds that file and goes to its header.
        .when(Boolean(sticky), (e) => e.child(div().id("sticky").absolute().top(0).left(0).right(0)
          .on_click((_e, cx) => { this.toggleFile(stickyPath); this.jump = stickyPath; cx.notify(); })
          .child(this.fileRow(sticky, this.folded(stickyPath), t, viewedBox))))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.files.length, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : "No changes")))))
      .when(Boolean(this.editing), (e) => e.child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child(`Comment on ${editingAt ?? ""}`))
        .child(h_flex().gap(8)
          .child(div().id("comment-input").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.commentInput).h_full().text_size(12).text_color(t.foreground)))
          .when(this.editing?.index >= 0, (e) => e.child(button("comment-delete", "Delete", false, (_e, cx) => this.deleteComment(this.editing.index, cx))))
          .child(button("comment-save", "Save", true, (_e, cx) => this.saveComment(cx, false)))))), t);
  }
}
