// What both review views share: the target repo's changed files, refreshed every 10 s and on file changes,
// but only while the view is on screen (a hidden one catches up when shown); the frame; short-lived notes.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { watchFolder } from "herdr";
import { target, key, mode, prFor, onScreen, commentsOf } from "./state.js";
import { changedFiles } from "./git.js";

const NOTE_MS = 8000;

export class RepoView {
  constructor(cx) {
    this.files = []; this.context = null; this.handle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.tick(cx));
  }

  // Hooks: a view's own state to drop when the review starts over, and what it loads after the file list.
  reset() {}
  async afterFiles(_context) {}

  tick(cx) { if (onScreen()) this.refresh(cx); else this.stale = true; }
  catchUp(cx) { if (key() !== this.context || (this.stale && onScreen())) { this.stale = false; this.refresh(cx); } }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const t = target(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.error = null; this.note = null; this.done = null;
      this.watched = null; this.limited = false; this.commentsKey = null; this.baseNote = null; this.baseName = null;
      this.reset();
    }
    if (!t.cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await changedFiles({ cwd: t.cwd, on: t.on, branchMode: mode() === "branch", prBase: prFor(t.branch)?.base });
        if (key() !== context) return;
        if (!r.root) { this.root = null; this.files = []; this.error = "Not a git repository"; this.reset(); return; }
        Object.assign(this, { root: r.root, on: t.on, files: r.files, hasHead: r.hasHead, against: r.against, baseName: r.baseName, limited: r.limited, error: null });
        this.baseNote = mode() === "branch" && r.hasHead && !r.base ? "No base branch to compare with: showing uncommitted changes" : null;
        this.commentsKey = `comments:${JSON.stringify([t.on, r.root])}`;
        this.watch(r.root, cx);
        await this.afterFiles(context);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.tick(cx);
        }
      } catch { this.watched = null; }
    });
  }

  comments() { return commentsOf(this.commentsKey); }

  // A note under the header (field "note": red, "done": grey) that hides after a few seconds.
  say(field, text) { this[field] = text; this[`${field}At`] = Date.now(); }
  shown(field) { return this[field] && Date.now() - (this[`${field}At`] ?? 0) < NOTE_MS ? this[field] : null; }

  // The frame both views draw in: rounded, with keyboard focus tracked; Esc goes to onEscape.
  frame(t, cx) {
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" && this.onEscape()) { this.handle.focus(); cx.stop_propagation(); cx.notify(); } });
  }
  onEscape() { return false; }

  notes(el, t) {
    const note = this.shown("note"), done = this.shown("done");
    return el
      .when(this.limited, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(note), (e) => e.child(div().px(10).py(6).text_size(11).text_color("#f85149").child(note)))
      .when(Boolean(done) && !note, (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.dim).child(done)));
  }

  // Keys from keys.json "mod:review", and "focus" when pane.go moves onto this copy.
  command(name) { if (name === "focus") this.handle.focus(); }
}
