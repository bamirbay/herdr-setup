// A review tab, tied to one terminal (props.agent): every changed file's diff in one scroll, a header per file (the
// top file's header sticks), line and whole-file comments sent to that agent after a preview, Viewed, only-this-file,
// and plain-letter keys (? lists them). Read-only (no comments) while the terminal runs no agent.
// It draws only the rows on screen and owns the scroll offset, after herdr-gitview's scroller: the sticky header,
// jumps and the reading position across refreshes are exact, and rows take their own clicks.
import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { panes, exec, hc, run, settings, shared, theme } from "herdr";
import { mode, tied, target, key, prFor, viewedOf, setViewed, commentsOf, setComments, onScreen } from "./state.js";
import { C, STATUS, anchor, message, loadDiffs, saveSent } from "./git.js";
import { RepoView } from "./repo.js";

const ROW = 20, HEAD = 36, LINE = 18, OVERSCAN = 4;
const TONE = { bad: C.red, good: C.green };
const KEYS = [
  ["j k  ↓ ↑", "next / previous line"], ["shift ↓ ↑", "extend the selection"], ["J K", "next / previous file"],
  ["space  shift-space", "page down / up"], ["g G", "top / bottom"], ["a  ⌘⇧C", "comment on the selection (double-click a line)"],
  ["v  ⌘E", "mark the file viewed"], ["o  ⌘⇧E", "only this file"], ["p  ⌘↵", "preview the comments, again to send"],
  ["esc", "close · clear the selection"], ["?", "these keys"],
];

// A row's identity across rebuilds: its file, kind and line number (hunk and note rows by their text).
const rowKey = (r) => (r.kind === "file" ? `${r.path}\0file` : `${r.path}\0${r.kind}\0${r.number ?? r.text}`);
const headerKey = (path) => `${path}\0file`;

// The last item whose top is at or above y (offsets: each item's top, then the total height).
export function indexAt(offsets, y) {
  let lo = 0, hi = offsets.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo;
}

// Word-wraps comment text to `width` characters per line.
export function wrap(text, width) {
  return text.split("\n").flatMap((p) => {
    const out = [];
    let line = "";
    for (const w of p.split(" ")) {
      line = line && (line + " " + w).length > width ? (out.push(line), w) : line ? `${line} ${w}` : w;
      while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    }
    out.push(line);
    return out;
  });
}

if ([0, 19, 20, 75, 1000].map((y) => indexAt([0, 20, 56, 76], y)).join() !== "0,0,1,2,2" || indexAt([0], 5) !== 0
  || wrap("aaa bbb ccc", 7).join("|") !== "aaa bbb|ccc" || wrap("x\ny", 5).join("|") !== "x|y" || wrap("abcdefghij", 4).join("|") !== "abcd|efgh|ij") throw new Error("review tab self-check failed");

export class ReviewTab extends RepoView {
  constructor(cx) {
    super(cx);
    this.areaH = 0; this.areaW = 0;
    this.composer = TextareaState.new({ placeholder: "Comment · ⌘↵ saves · Esc cancels" });
    this.composer.set_auto_grow(1, 6);
    // ⌘↵ saves; a plain Enter stays a new line in the comment.
    this.composer.on("submit", (e, cx) => { if (e?.secondary) this.saveComment(cx); });
  }

  // A context switch keeps the old rows on screen (dimmed) until the new diff replaces them; per-view choices go.
  reset() {
    this.rows ??= []; this.headers ??= new Map(); this.auto ??= new Set(); this.items ??= []; this.sizes ??= []; this.offsets ??= [0];
    this.fileOf ??= []; this.keyIndex ??= new Map(); this.top ??= 0;
    Object.assign(this, { fold: {}, only: null, sel: null, editing: null, preview: null, help: false, sig: null, memo: null, jump: null, reveal: null });
  }

  // No refresh while a comment or the send preview is open (it would move what you're writing about).
  paused() { return Boolean(this.editing || this.preview); }

  async afterFiles(context) {
    const d = await loadDiffs({ root: this.root, on: this.on, files: this.files, hasHead: this.hasHead, against: this.against, index: this.index }, this.sig);
    if (!d || key() !== context) return;
    const selKeys = this.sel && [this.rows[this.sel.a], this.rows[this.sel.b]].map((r) => r && rowKey(r));
    Object.assign(this, { sig: d.sig, rows: d.rows, auto: d.auto, cut: d.cut, rowsVer: (this.rowsVer ?? 0) + 1 });
    this.headers = new Map(d.rows.filter((r) => r.kind === "file").map((r) => [r.path, r]));
    if (this.only && !this.headers.has(this.only)) this.only = null;
    // The selection follows its lines; it goes when they do.
    if (selKeys) {
      const at = new Map(d.rows.map((r, i) => [rowKey(r), i])), a = at.get(selKeys[0]), b = at.get(selKeys[1]);
      this.sel = a !== undefined && b !== undefined ? { a, b } : null;
    }
  }

  // The keyboard goes back to the comment box while one is open, else to the tab.
  focusSelf() { (this.editing ? this.composer : this.handle).focus(); }

  command(name, cx) {
    if (name === "focus") this.focusSelf();
    if (name === "comment") this.startComment(cx);
    if (name === "send") this.requestSend(cx);
    if (name === "viewed") this.toggleViewed(cx);
    if (name === "only") this.toggleOnly(cx);
  }

  // Comments need an agent behind the tab; checked live, so starting Claude there turns them on.
  canComment() { return Boolean(panes().find((p) => p.terminal === tied())?.status); }

  viewed(path) { const h = this.headers.get(path); return Boolean(h) && viewedOf(this.commentsKey)[path] === h.hash; }

  // Only-this-file folds the rest; otherwise a click decides, else viewed and bulky files start folded.
  folded(path) {
    if (this.only) return path !== this.only;
    return this.fold[path] ?? (this.viewed(path) || this.auto.has(path));
  }

  // ---- Layout: items, their heights and tops, and the scroll offset

  // Header, the file's whole-file comments, then its rows (a folded file: header and comments only). A line comment
  // follows the line it ends on, else its file's end (line gone or folded); comments on files no longer changed go last.
  buildItems() {
    const comments = this.comments(), at = new Map(), placed = new Set(), out = [];
    const spot = (path, kind, number) => `${path}\0${kind}\0${number}`;
    comments.forEach((c, index) => { if (c.end) { const k = spot(c.path, c.end.kind, c.end.number); at.set(k, [...(at.get(k) ?? []), index]); } });
    const comment = (index) => { placed.add(index); out.push({ type: "comment", key: `c\0${index}`, c: comments[index], index, path: comments[index].path }); };
    const rest = (path) => comments.forEach((c, index) => { if (c.path === path && !placed.has(index)) comment(index); });
    let path = null, folded = false;
    this.rows.forEach((row, i) => {
      if (row.kind === "file") {
        if (path !== null) rest(path);
        path = row.path; folded = this.folded(path);
        out.push({ type: "file", key: rowKey(row), row, i, folded, path });
        comments.forEach((c, index) => { if (c.path === path && !c.end && !placed.has(index)) comment(index); });
      } else if (!folded) {
        out.push({ type: "row", key: rowKey(row), row, i, path });
        for (const index of at.get(spot(row.path, row.kind, row.number)) ?? []) if (!placed.has(index)) comment(index);
      }
    });
    if (path !== null) rest(path);
    comments.forEach((c, index) => { if (!placed.has(index)) comment(index); });
    return out;
  }

  // Characters per comment line at the current width (the comment font is about 7px a character).
  commentWidth() { return Math.max(24, Math.floor((this.areaW - 90) / 7)); }
  size(it) { return it.type === "file" ? HEAD : it.type === "comment" ? 8 + LINE * wrap(`› ${it.c.text}`, this.commentWidth()).length : ROW; }

  // Rebuilds items when something they show changed, keeping the row at the top of the view where it was.
  layout(list, viewedMap) {
    // The selection isn't in here (rows read it when drawn); the wrap width is, as comment heights depend on it.
    const memo = JSON.stringify([this.rowsVer, this.fold, this.only, list, viewedMap, this.commentWidth()]);
    if (memo === this.memo) return;
    const keep = this.items.length && !this.jump ? this.anchorAt() : null;
    this.memo = memo;
    this.items = this.buildItems();
    this.sizes = this.items.map((it) => this.size(it));
    this.offsets = [0];
    for (const s of this.sizes) this.offsets.push(this.offsets.at(-1) + s);
    this.keyIndex = new Map(this.items.map((it, i) => [it.key, i]));
    let head = 0;
    this.fileOf = this.items.map((it, i) => (it.type === "file" ? (head = i) : head));
    if (keep) {
      const i = this.keyIndex.get(keep.key), h = this.keyIndex.get(headerKey(keep.path));
      this.top = i !== undefined ? this.offsets[i] + keep.offset : h !== undefined ? this.offsets[h] : this.top;
    }
  }

  anchorAt() { const i = indexAt(this.offsets, this.top), it = this.items[i]; return { key: it?.key, path: it?.path, offset: this.top - this.offsets[i] }; }
  total() { return this.offsets.at(-1) ?? 0; }
  clamp() { this.top = Math.min(Math.max(0, this.top), Math.max(0, this.total() - this.areaH)); }

  // Pending moves, after layout: a file header to the top; a row into view below the sticky header.
  applyMoves() {
    if (this.jump) {
      const i = this.keyIndex.get(headerKey(this.jump));
      if (i !== undefined) this.top = this.offsets[i];
      this.jump = null;
    }
    if (this.reveal) {
      const i = this.keyIndex.get(this.reveal);
      if (i !== undefined) {
        if (this.offsets[i] < this.top + HEAD) this.top = this.offsets[i] - HEAD - 2 * ROW;
        else if (this.offsets[i + 1] > this.top + this.areaH) this.top = this.offsets[i + 1] - this.areaH + 2 * ROW;
      }
      this.reveal = null;
    }
    this.clamp();
  }

  // The file at the top of the view: the sticky header's.
  topPath() { return this.items[this.fileOf[indexAt(this.offsets, this.top)]]?.path ?? null; }
  // What cmd-e / v and cmd-shift-e / o act on: the selected line's file while it is on screen, else the top file.
  currentPath() {
    const i = this.sel ? this.keyIndex.get(rowKey(this.rows[this.sel.b] ?? {})) : undefined;
    const onView = i !== undefined && this.offsets[i] >= this.top && this.offsets[i + 1] <= this.top + this.areaH;
    return onView ? this.items[i].path : this.topPath();
  }

  // ---- Actions

  // A header click: fold or unfold; in only-this-file, switch to that file.
  toggleFile(path) {
    if (this.only) { this.only = path; this.jump = path; } else this.fold[path] = !this.folded(path);
  }

  // v / ⌘E: the current file. Viewed folds it in place: its header stays at the top and the next file follows.
  toggleViewed(cx) { const path = this.currentPath(); if (path) this.toggleViewedPath(path, cx); }

  toggleViewedPath(path, cx) {
    const h = this.headers.get(path);
    if (!h) return;
    const map = { ...viewedOf(this.commentsKey) };
    if (map[path] === h.hash) delete map[path]; else map[path] = h.hash;
    delete this.fold[path];
    this.only = null;
    setViewed(this.commentsKey, map);
    this.jump = path;
    cx.notify();
  }

  // Only the current file open; again: back to all files.
  toggleOnly(cx) {
    const path = this.only ?? this.currentPath();
    if (!path) return;
    this.only = this.only ? null : path;
    this.jump = path;
    cx.notify();
  }

  // Select a line, or extend the selection within its file.
  selectRow(i, extend) {
    if (this.rows[i]?.number === undefined) return;
    this.sel = extend && this.sel && this.rows[this.sel.a]?.path === this.rows[i].path ? { ...this.sel, b: i } : { a: i, b: i };
  }

  // j / k: the next or previous line with a number, from the selection or the top of the view.
  moveLine(dir, extend) {
    const can = (it) => it?.type === "row" && it.row.number !== undefined;
    const cur = this.sel ? this.keyIndex.get(rowKey(this.rows[this.sel.b] ?? {})) : undefined;
    let i = cur ?? indexAt(this.offsets, this.top + HEAD) - dir;
    do i += dir; while (i >= 0 && i < this.items.length && !can(this.items[i]));
    if (!can(this.items[i])) return;
    this.selectRow(this.items[i].i, extend);
    this.reveal = this.items[i].key;
  }

  // J / K: the next file's header to the top; back: this file's header, or the one before when already there.
  moveFile(dir) {
    const heads = this.items.map((it, i) => (it.type === "file" ? i : -1)).filter((i) => i >= 0);
    const here = this.fileOf[indexAt(this.offsets, this.top)] ?? 0, k = heads.indexOf(here);
    const to = dir > 0 ? heads[k + 1] : this.top > this.offsets[here] + 1 ? here : heads[k - 1];
    if (to !== undefined) this.jump = this.items[to].path;
  }

  startComment(cx) {
    if (!this.canComment()) { this.say("note", "Read-only: no agent runs in this terminal"); cx.notify(); return; }
    const rows = this.selectedRows();
    if (!rows.length) { this.say("note", "Select a line first: click it, shift-click for a range, or use j / k"); cx.notify(); return; }
    this.openComposer({ index: -1, path: rows[0].path, rows }, "", cx);
  }

  startFileComment(path, cx) {
    if (!this.canComment()) return;
    this.openComposer({ index: -1, path, rows: [], file: true }, "", cx);
  }

  editComment(index, cx) {
    if (!this.canComment()) return;
    this.openComposer({ index }, this.comments()[index]?.text ?? "", cx);
  }

  openComposer(editing, text, cx) {
    // A comment being written isn't replaced: finish it (⌘↵) or close it (Esc) first.
    if (this.editing && this.composer.value().trim()) { this.composer.focus(); this.say("note", "Save (⌘↵) or close (Esc) the open comment first"); cx.notify(); return; }
    this.note = null; this.done = null; this.preview = null;
    this.editing = editing;
    this.composer.set_value(text);
    this.composer.focus();
    cx.notify();
  }

  selectedRows() {
    if (!this.sel) return [];
    const lo = Math.min(this.sel.a, this.sel.b), hi = Math.max(this.sel.a, this.sel.b), path = this.rows[this.sel.a]?.path;
    return this.rows.slice(lo, hi + 1).filter((r) => r.path === path && r.number !== undefined);
  }

  saveComment(cx) {
    const e = this.editing, text = this.composer.value().trim(), list = [...this.comments()];
    if (!e) return;
    if (e.index === -1 && text && e.file) list.push({ path: e.path, at: `${e.path} (whole file)`, quote: "", text, end: null });
    else if (e.index === -1 && text) {
      const last = e.rows.at(-1), quote = e.rows.find((r) => r.text.trim())?.text.trim().replace(/`/g, "'").slice(0, 80) ?? "";
      list.push({ path: e.path, at: anchor(e.path, e.rows), quote, text, end: { kind: last.kind, number: last.number } });
    } else if (e.index >= 0) {
      if (text) list[e.index] = { ...list[e.index], text }; else list.splice(e.index, 1);
    }
    setComments(this.commentsKey, list);
    this.editing = null; this.sel = null; this.savedAt = Date.now(); this.handle.focus();
    cx.notify();
  }

  deleteComment(index, cx) {
    const list = [...this.comments()];
    list.splice(index, 1); this.editing = null;
    setComments(this.commentsKey, list);
    this.handle.focus();
    cx.notify();
  }

  // p / ⌘↵ / Send: while writing, save the comment; else show the exact message; with it shown, send it.
  requestSend(cx) {
    if (this.editing) { this.saveComment(cx); return; }
    // ⌘↵ can reach both the comment box (save) and the review keys (send): one press only saves.
    if (Date.now() - (this.savedAt ?? 0) < 400) return;
    if (this.preview) { this.send(cx); return; }
    if (!this.comments().length) { this.say("note", "No comments to send"); cx.notify(); return; }
    if (!this.canComment()) { this.say("note", `${tied()} isn't running an agent`); cx.notify(); return; }
    this.preview = true;
    cx.notify();
  }

  // Every comment on this repo in one message to the tab's agent, then back to that agent.
  // A blocked agent refuses it (hc send without --force). The worktree is saved first, for Since sent; a failed send
  // still moves that point (the next send saves it again).
  send(cx) {
    const list = this.comments();
    if (!list.length || this.busy) return;
    const pane = panes().find((p) => p.terminal === tied());
    if (!pane?.status) { this.preview = null; this.say("note", `${tied()} isn't running an agent`); cx.notify(); return; }
    const ck = this.commentsKey, root = this.root, on = this.on;
    this.busy = "send"; this.note = null; this.done = null;
    cx.spawn(async (cx) => {
      try {
        const saved = await saveSent(root, on).then(() => "", (e) => ` · Since sent not saved: ${e.message ?? e}`);
        const r = await hc(["send", pane.terminal, message(list)]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        // Only the comments that went: one saved meanwhile stays.
        const went = new Set(list.map((c) => JSON.stringify(c)));
        setComments(ck, commentsOf(ck).filter((c) => !went.has(JSON.stringify(c))));
        this.preview = null;
        this.say("done", `Sent ${list.length} comment${list.length === 1 ? "" : "s"} to ${pane.program?.name ?? pane.terminal}${saved}`);
        run("tab.select", { id: pane.tab });
        run("pane.focus", { pane: pane.pane });
      } catch (e) { this.say("note", `Send failed: ${e.message ?? e}`); }
      finally { this.busy = false; this.stale = true; cx.notify(); } // Since sent starts over from here
    });
    cx.notify();
  }

  // Plain-letter keys, while no comment or preview has the keyboard; ⌘ / ctrl / alt chords stay the app's.
  onKey(e, cx) {
    if (e.key === "escape") {
      if (this.help) this.help = false; else if (this.preview) this.preview = null; else if (this.editing) this.editing = null;
      else if (this.sel) this.sel = null; else return false;
      this.focusSelf();
      return true;
    }
    if (this.editing) return false;
    const m = e.modifiers;
    if (m.platform || m.control || m.alt || m.function) return false;
    const ch = e.key_char ?? e.key, page = Math.max(ROW, this.areaH - HEAD - 2 * ROW);
    const once = (f) => { if (!e.is_held) f(); };
    switch (ch === " " ? "space" : ch) {
      case "j": this.moveLine(1, false); break;
      case "k": this.moveLine(-1, false); break;
      case "J": this.moveFile(1); break;
      case "K": this.moveFile(-1); break;
      case "g": this.top = 0; break;
      case "G": this.top = this.total(); break;
      case "a": once(() => this.startComment(cx)); break;
      case "v": once(() => this.toggleViewed(cx)); break;
      case "o": once(() => this.toggleOnly(cx)); break;
      case "p": once(() => this.requestSend(cx)); break;
      case "?": this.help = !this.help; break;
      default:
        if (e.key === "down" || e.key === "up") this.moveLine(e.key === "down" ? 1 : -1, m.shift);
        else if (e.key === "space" || e.key === "pagedown" || e.key === "pageup") this.top += (e.key === "pageup" || (e.key === "space" && m.shift) ? -page : page);
        else return false;
    }
    this.clamp();
    return true;
  }

  // ---- Rows

  diffRow(it, t) {
    const { kind, number, text } = it.row;
    if (kind === "@") return div().w_full().px(12).h(ROW).flex_none().truncate().bg(C.hunk).text_color(C.hunkText).child(text);
    const tint = kind === "+" ? C.add : kind === "-" ? C.del : null, gutter = kind === "+" ? C.addGutter : kind === "-" ? C.delGutter : null;
    return h_flex().w_full().h(ROW).flex_none()
      .when(this.isSelected(it.i), (e) => e.bg(t.accent + "40")).when(Boolean(tint) && !this.isSelected(it.i), (e) => e.bg(tint))
      .child(div().w(44).h_full().pr(8).flex_none().flex().items_center().justify_end().text_color(t.dim)
        .when(Boolean(gutter), (e) => e.bg(gutter).text_color(t.foreground)).child(number === undefined ? "" : String(number)))
      .child(div().w(16).flex_none().text_center().text_color(t.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  isSelected(i) { return Boolean(this.sel) && i >= Math.min(this.sel.a, this.sel.b) && i <= Math.max(this.sel.a, this.sel.b); }

  // A file header: a gap, then a bar. Its own handlers: a click folds; "＋ comment" comments on the whole file.
  fileRow(id, path, folded, t, extra) {
    const { file, size } = this.headers.get(path), parts = path.split("/"), name = parts.pop(), viewed = this.viewed(path);
    return div().w_full().h(HEAD).flex_none().pt(6).bg(t.background).child(h_flex().id(id).w_full().h(HEAD - 6).pr(10).gap(8).items_center()
      .bg(t.raised).border_t(1).border_b(1).border_color(t.border).text_size(13).cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleFile(path); if (extra) this.jump = path; cx.notify(); })
      .child(div().w(3).h_full().flex_none().bg(viewed ? C.green : t.accent))
      .child(div().w(12).flex_none().text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(div().w(12).flex_none().font_semibold().text_color(STATUS[file.status] ?? t.dim).child(file.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().font_semibold().text_color(t.foreground).flex_none().child(name)))
      .when(folded && !viewed, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${size.toLocaleString()} lines · folded`)))
      .when(file.add > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(C.green).child(`+${file.add}`)))
      .when(file.del > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(C.red).child(`−${file.del}`)))
      .when(this.canComment(), (e) => e.child(div().id(`${id}-fc`).flex_none().px(6).h(22).flex().items_center().rounded(5).text_size(11).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); this.startFileComment(path, cx); }).child("＋ comment")))
      .child(div().id(`${id}-v`).flex_none().px(8).h(22).flex().items_center().rounded(5).border_1().border_color(viewed ? C.green : t.border)
        .bg(viewed ? C.add : t.background).text_size(11).text_color(viewed ? C.green : t.dim)
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleViewedPath(path, cx); }).child(viewed ? "✓ Viewed" : "Viewed")));
  }

  commentRow(it, t) {
    const lines = wrap(`› ${it.c.text}`, this.commentWidth());
    return v_flex().w_full().h(8 + LINE * lines.length).flex_none().py(4).pl(57).pr(8).justify_center()
      .bg(C.comment).border_l(3).border_color(t.accent).text_color(t.foreground).font_family(settings().ui_font_family ?? "Geist").cursor_pointer()
      .children(lines.map((l) => div().h(LINE).truncate().child(l || " ")));
  }

  // Click a line to select it, shift-click to extend, double-click to comment.
  clickRow(it, e, cx) {
    this.selectRow(it.i, e.modifiers.shift && e.click_count < 2);
    if (e.click_count >= 2) this.startComment(cx);
    cx.notify();
  }

  drawItem(it, i, t) {
    if (it.type === "file") return this.fileRow(`h-${i}`, it.path, it.folded, t);
    if (it.type === "comment") return div().id(`c-${i}`).on_click((_e, cx) => this.editComment(it.index, cx)).child(this.commentRow(it, t));
    return div().id(`r-${i}`).on_click((e, cx) => this.clickRow(it, e, cx)).child(this.diffRow(it, t));
  }

  // ---- Render

  render(cx) {
    this.catchUp(cx);
    // Opening the tab, or coming back to it, gives it the keyboard. Herdr hands focus over after it draws, so ask
    // again for up to a second (after herdr-gitview), until it lands once: a later click elsewhere keeps its focus.
    const shown = onScreen();
    if (shown && !this.wasShown) {
      this.got = false;
      for (let k = 1; k <= 10; k++) cx.timer.after(100 * k, () => {
        if (this.handle.is_focused()) this.got = true;
        else if (!this.got && onScreen() && !this.editing) this.handle.focus();
      });
    }
    this.wasShown = shown;
    const t = theme();
    // A sidebar click sets review.open to {path, at}: unfold that file and bring its header to the top, once per click.
    const want = (shared("review.open") ?? {})[tied()];
    if (want?.at && want.at !== this.jumped && this.headers.has(want.path)) {
      this.jumped = want.at; this.jump = want.path;
      if (this.only) this.only = want.path; else this.fold[want.path] = false;
    }
    const can = this.canComment(), list = this.comments(), pr = prFor(target()), viewedMap = viewedOf(this.commentsKey);
    this.layout(list, viewedMap);
    this.applyMoves();
    // From the loaded diff's file entries (new files' line counts are set there).
    const add = [...this.headers.values()].reduce((n, h) => n + h.file.add, 0), del = [...this.headers.values()].reduce((n, h) => n + h.file.del, 0);
    const viewedCount = [...this.headers.values()].filter((h) => viewedMap[h.path] === h.hash).length;
    const editingAt = this.editing ? (this.editing.index >= 0 ? list[this.editing.index]?.at : this.editing.file ? `${this.editing.path} (whole file)` : anchor(this.editing.path, this.editing.rows)) : null;

    // The rows on screen, placed at their offsets; the sticky header is the top file's, pushed up by the next header.
    const n = this.items.length, first = indexAt(this.offsets, this.top);
    const start = Math.max(0, first - OVERSCAN), end = Math.min(n, indexAt(this.offsets, this.top + this.areaH) + 1 + OVERSCAN);
    const head = this.fileOf[first], next = this.fileOf.findIndex((h, i) => i > first && h !== head && this.items[i].type === "file");
    const stickyTop = next > 0 ? Math.min(0, this.offsets[next] - this.top - HEAD) : 0;
    const total = this.total(), thumbH = total > this.areaH ? Math.max(24, (this.areaH * this.areaH) / total) : 0;
    const thumbTop = thumbH ? (this.top / (total - this.areaH)) * (this.areaH - thumbH) : 0;
    const button = (id, label, on, action) => div().id(id).h(32).px(14).flex().items_center().rounded(8).bg(on ? t.solid : t.raised).text_color(on ? t.solid_foreground : t.dim).text_size(12).when(on, (e) => e.cursor_pointer()).on_click(action).child(label);
    const chip = (id, label, color, action) => div().id(id).px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11).text_color(color ?? t.dim).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action).child(label);

    return this.notes(this.frame(t, cx)
      // Any click gives the tab the keyboard, so the review keys work (read-only tabs too).
      .on_mouse_down("left", () => this.focusSelf())
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().flex_none().child(`${this.files.length} file${this.files.length === 1 ? "" : "s"}`))
        .when(this.files.length > 0, (e) => e.child(div().text_size(11).text_color(viewedCount ? C.green : t.dim).child(`${viewedCount}/${this.files.length} viewed`)))
        .when(Boolean(this.only), (e) => e.child(chip("only", "one file · o for all", t.foreground, (_e, cx) => this.toggleOnly(cx))))
        .when(add > 0, (e) => e.child(div().text_size(11).text_color(C.green).child(`+${add}`)))
        .when(del > 0, (e) => e.child(div().text_size(11).text_color(C.red).child(`−${del}`)))
        .child(div().text_size(10.5).text_color(t.dim).child(mode() === "branch" ? `vs ${this.baseName ?? "origin/main"}` : mode() === "sent" ? "since your last send" : "uncommitted"))
        .when(Boolean(pr), (e) => e.child(chip("pr", pr.label ?? `#${pr.number}`, TONE[pr.tone] ?? t.muted, () => { exec("open", [pr.url]).catch(() => null); })))
        .child(div().flex_1())
        .child(chip("keys", "? keys", null, (_e, cx) => { this.help = !this.help; cx.notify(); }))
        .when(!can, (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child("read-only · not an agent")))
        .when(can && list.length > 0, (e) => e.child(div().id("send").h(26).px(10).flex().items_center().rounded(6).bg(this.busy ? t.raised : t.solid).text_color(this.busy ? t.dim : t.solid_foreground).text_size(12).cursor_pointer()
          .on_click((_e, cx) => this.requestSend(cx)).child(this.busy === "send" ? "Sending…" : `Send ${list.length} ⌘↵`))))
      .when(Boolean(this.baseNote), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(this.baseNote)))
      .when(this.cut, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Over 50,000 diff lines: later files show their header only")))
      .child(div().id("diff-area").flex_1().min_h(0).min_w(0).relative().overflow_hidden().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        // Sizes, wheel deltas and pointer positions come in window px; rows are laid out in px at zoom 1 (as the picker does).
        .on_size_change((size, cx) => {
          const h = size.height / settings().zoom, w = size.width / settings().zoom;
          if (h !== this.areaH || w !== this.areaW) { this.areaH = h; this.areaW = w; cx.notify(); }
        })
        .on_scroll_wheel((e, cx) => { const before = this.top; this.top -= e.delta.y / settings().zoom; this.clamp(); if (this.top !== before) cx.notify(); })
        .on_mouse_move((e, cx) => {
          if (!this.drag) return;
          this.top = this.drag.top + ((e.position.y - this.drag.y) / settings().zoom) * (total - this.areaH) / Math.max(1, this.areaH - thumbH);
          this.clamp(); cx.notify();
        })
        .on_mouse_up("left", () => { this.drag = null; })
        .on_hover((over) => { if (!over) this.drag = null; }) // released outside: no stuck drag
        .when(this.switching(), (e) => e.opacity(0.55))
        .child(v_flex().absolute().left(0).right(0).top(this.offsets[start] - this.top)
          .children(this.items.slice(start, end).map((it, k) => this.drawItem(it, start + k, t))))
        .when(n > 0 && this.items[head]?.type === "file", (e) => e.child(div().id("sticky-wrap").absolute().left(0).right(0).top(stickyTop).on_click((_e, cx) => cx.stop_propagation())
          .child(this.fileRow("sticky", this.items[head].path, this.items[head].folded, t, true))))
        .when(thumbH > 0, (e) => e.child(div().id("thumb").absolute().right(2).top(thumbTop).w(6).h(thumbH).rounded(3).bg(t.dim + "80")
          .on_mouse_down("left", (ev, cx) => { cx.stop_propagation(); this.drag = { y: ev.position.y, top: this.top }; })))
        .when(!this.files.length, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : "No changes"))))
        .when(this.help, (e) => e.child(v_flex().id("help").absolute().top(8).right(14).p(10).gap(3).rounded(8).bg(t.popover ?? t.raised).border_1().border_color(t.border)
          .font_family(settings().ui_font_family ?? "Geist").text_size(12).on_click((_e, cx) => { cx.stop_propagation(); this.help = false; cx.notify(); })
          .children(KEYS.map(([k, what]) => h_flex().gap(10).child(div().w(130).text_color(t.foreground).child(k)).child(div().text_color(t.dim).child(what)))))))
      .when(Boolean(this.preview), (e) => e.child(v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child(`This goes to ${panes().find((p) => p.terminal === tied())?.program?.name ?? tied()}:`))
        .child(div().max_h(180).child(v_flex().id("preview").max_h(180).overflow_y_scrollbar().p(8).rounded(6).bg(t.raised).font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
          .children(message(list).split("\n").map((l) => div().child(l || " ")))))
        .child(h_flex().gap(8).child(div().flex_1())
          .child(button("preview-cancel", "Cancel", false, (_e, cx) => { this.preview = null; this.handle.focus(); cx.notify(); }))
          .child(button("preview-send", this.busy === "send" ? "Sending…" : "Send ⌘↵", true, (_e, cx) => this.send(cx))))))
      .when(Boolean(this.editing), (e) => e.child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child(`Comment on ${editingAt ?? ""}`))
        .child(h_flex().gap(8).items_end()
          .child(div().id("comment-input").flex_1().min_w(0).px(10).py(6).rounded(8).border_1().border_color(t.accent).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.composer).w_full().text_size(12).text_color(t.foreground)))
          .when(this.editing?.index >= 0, (e) => e.child(button("comment-delete", "Delete", false, (_e, cx) => this.deleteComment(this.editing.index, cx))))
          .child(button("comment-save", "Save ⌘↵", true, (_e, cx) => this.saveComment(cx)))))), t);
  }
}
