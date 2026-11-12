// Review, in three roles:
// - the right sidebar: the changed files of the focused terminal's repo (a review tab's terminal while one is focused);
//   clicking a file opens it in that terminal's review tab;
// - a review tab, tied to one terminal (props.agent): one file's diff, with line comments sent to that agent;
//   read-only while the terminal runs no agent;
// - a launcher (mod.open, cmd-shift-g): opens or shows the focused terminal's review tab, then closes.
// Shared state: review.mode, review.open (terminal -> file), review.comments (repo -> comments), review.tabs (terminal -> its tab's name).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, hc, readTextFile, watchFolder, theme, settings, nextCommand, props, run, closeOverlay, notify, shared, setShared } from "herdr";

// GitHub-dark style diff colors.
const C = { add: "#2ea04333", addGutter: "#2ea0434d", del: "#f8514933", delGutter: "#f851494d", hunk: "#388bfd1f", hunkText: "#8fb8ff",
  comment: "#388bfd2e", green: "#3fb950", red: "#f85149", amber: "#d29922" };
const STATUS = { A: C.green, D: C.red, U: C.red, M: C.amber };

const mode = () => shared("review.mode") ?? "branch";
const tied = () => props()?.agent ?? null;
const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
const tabsOf = () => shared("review.tabs") ?? {};

// The terminal a review is about: the tab's own; in the sidebar, the focused pane's, or a focused review tab's terminal.
function target() {
  if (tied()) return { terminal: tied(), cwd: panes().find((p) => p.terminal === tied())?.cwd || props().cwd, on: props().on ?? null };
  const f = focused(), pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane?.mod === "review") {
    const name = spaces().flatMap((s) => s.tabs).find((t) => t.id === pane.tab)?.name;
    const hit = Object.entries(tabsOf()).find(([, v]) => v.name === name);
    if (hit) return { terminal: hit[0], cwd: panes().find((p) => p.terminal === hit[0])?.cwd || hit[1].cwd, on: hit[1].on ?? null };
  }
  const space = spaces().find((s) => s.active);
  const on = f?.pane === null ? machineOf(f.terminal) : space?.machine ?? null;
  return { terminal: pane?.terminal ?? f?.terminal ?? null, cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => { const t = target(); return JSON.stringify([t.cwd, t.on, mode()]); };

const commentsOf = (ck) => (shared("review.comments") ?? {})[ck] ?? [];
function setComments(ck, list) {
  const all = { ...(shared("review.comments") ?? {}) };
  if (list.length) all[ck] = list; else delete all[ck];
  setShared("review.comments", all);
}

// Opens the terminal's review tab, or shows it, at `path` when given, with the file list beside it.
function openTab(path) {
  const t = target();
  if (!t.terminal) { notify({ title: "Focus a terminal first", body: "A review tab belongs to the terminal it was opened from.", level: "warning" }); return; }
  if (path) setShared("review.open", { ...(shared("review.open") ?? {}), [t.terminal]: path });
  const tabs = { ...tabsOf() }, space = spaces().find((s) => s.active);
  const existing = tabs[t.terminal] && space?.tabs.find((x) => x.name === tabs[t.terminal].name);
  if (existing) run("tab.select", { id: existing.id });
  else {
    const pane = panes().find((p) => p.terminal === t.terminal), tab = space?.tabs.find((x) => x.id === pane?.tab);
    let name = `Review · ${tab?.named ? tab.name : pane?.program?.name ?? t.terminal}`;
    // shortcut: tab names tie review tabs to terminals, so renaming a review tab unties it; tie by pane id if Herdr exposes one.
    if (Object.entries(tabs).some(([k, v]) => k !== t.terminal && v.name === name)) name += ` (${t.terminal})`;
    tabs[t.terminal] = { name, cwd: t.cwd, on: t.on };
    setShared("review.tabs", tabs);
    run("tab.new", { space: space?.id, name, mod: "review", props: { agent: t.terminal, cwd: t.cwd, on: t.on } });
  }
  run("layout.select", { stack: "panel-body", child: "changes" });
  run("layout.show", { id: "panel" });
}

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const letter = (s) => (s[0] === "U" ? "U" : s[0] === "D" ? "D" : s[0] === "A" ? "A" : "M");

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

// Where a comment points: "app/x.py:42" or "app/x.py:10-14"; only removed lines count in the old file.
export function anchor(path, rows) {
  const nums = rows.map((r) => r.number).filter((n) => n !== undefined);
  const at = nums.length ? (nums[0] === nums.at(-1) ? `${nums[0]}` : `${nums[0]}-${nums.at(-1)}`) : "";
  return `${path}${at ? `:${at}` : ""}${rows.every((r) => r.kind === "-") ? " (removed)" : ""}`;
}

export function message(comments) {
  return ["Review comments:", ...comments.map((c) => `- ${c.at}${c.quote ? ` \`${c.quote}\`` : ""} — ${c.text}`)].join("\n");
}

if (anchor("a.py", [{ kind: "+", number: 4 }, { kind: "+", number: 6 }]) !== "a.py:4-6"
  || anchor("a.py", [{ kind: "-", number: 9 }]) !== "a.py:9 (removed)"
  || message([{ at: "a.py:4", quote: "x = 1", text: "why?" }]) !== "Review comments:\n- a.py:4 `x = 1` — why?") throw new Error("review self-check failed");

export default class Review extends View {
  init(_props, cx) {
    if (props()?.overlay && !tied()) {
      this.launcher = true;
      cx.spawn(async () => { openTab(); closeOverlay(props().overlay); });
      return;
    }
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.commentsKey = null; this.sel = null; this.editing = null;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.commentInput = InputState.new({ placeholder: "Comment · Enter saves · ⌘Enter saves and sends · Esc cancels" });
    this.commentInput.on("submit", (e, cx) => this.saveComment(cx, e?.secondary));
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // keys.json "mod:review": review.comment, review.send, review.open
    cx.spawn(async (cx) => {
      for (;;) {
        const command = (await nextCommand()).split(/[.:]/).pop();
        if (command === "comment") this.startComment(cx);
        if (command === "send") this.send(cx);
        if (command === "open") openTab();
        cx.notify();
      }
    });
  }

  comments() { return commentsOf(this.commentsKey); }

  // Comments need an agent behind the tab; checked live, so starting Claude there turns them on.
  canComment() { return Boolean(tied() && panes().find((p) => p.terminal === tied())?.status); }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = target(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null; this.sel = null; this.editing = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.done = null; this.watched = null; this.limited = false;
      this.commentsKey = null; this.baseNote = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        // Branch mode compares with where this branch left origin's default branch.
        let base = null;
        if (mode() === "branch" && head.code === 0) {
          for (const ref of ["origin/HEAD", "origin/main"]) {
            const r = await git(["merge-base", "HEAD", ref]);
            if (r.code === 0) { base = r.stdout.trim(); break; }
          }
        }
        const target = base ?? "HEAD";
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", target, "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          // Branch mode: tracked files come from the diff against the base below.
          if (base && !fresh) continue;
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (base) {
          const names = await git(["diff", base, "--name-status", "-z", "--no-renames"]);
          if (names.code !== 0) throw new Error(names.stderr);
          const parts = names.stdout.split("\0");
          const tracked = [];
          for (let i = 0; i + 1 < parts.length && tracked.length < 1000; i += 2) {
            if (parts[i + 1]) tracked.push({ path: parts[i + 1], status: letter(parts[i]), fresh: false, ...(stats[parts[i + 1]] ?? { add: 0, del: 0 }) });
          }
          files.unshift(...tracked);
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.target = target; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.baseNote = mode() === "branch" && !base ? "No origin/main to compare with: showing uncommitted changes" : null;
        this.commentsKey = `comments:${JSON.stringify([on, root])}`;
        this.watch(root, cx);
        if (!tied()) return; // The sidebar lists files; only a review tab loads a diff.
        const want = (shared("review.open") ?? {})[tied()];
        this.open = files.some((f) => f.path === want) ? want : files.some((f) => f.path === this.open) ? this.open : files[0]?.path ?? null;
        if (this.open !== want && this.open) setShared("review.open", { ...(shared("review.open") ?? {}), [tied()]: this.open });
        if (!this.open) { this.setLines([]); return; }
        try { await this.load(this.open, context); }
        catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? [this.target] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 70));
  }

  // The review tab follows review.open, which the sidebar sets.
  pick(path, cx) {
    this.open = path; this.setLines([]); this.note = null; this.sel = null; this.editing = null;
    const context = this.context;
    cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
  }

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
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Click picks a line, shift-click extends the selection.
  select(i, extend, cx) {
    if (this.rows[i]?.number === undefined) return;
    this.sel = extend && this.sel?.path === this.open ? { ...this.sel, b: i } : { path: this.open, a: i, b: i };
    this.handle.focus();
    cx.notify();
  }

  selectedRows() {
    if (!this.sel || this.sel.path !== this.open) return [];
    const lo = Math.min(this.sel.a, this.sel.b), hi = Math.max(this.sel.a, this.sel.b);
    return this.rows.slice(lo, hi + 1).filter((r) => r.number !== undefined);
  }

  startComment(cx) {
    if (!this.canComment()) return;
    const rows = this.selectedRows();
    if (!rows.length) { this.note = "Select a line first: click it, shift-click for a range"; cx.notify(); return; }
    this.note = null; this.done = null;
    this.editing = { index: -1, path: this.open, rows };
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
    if (!list.length || this.busy || !tied()) return;
    const pane = panes().find((p) => p.terminal === tied());
    if (!pane?.status) { this.note = `${tied()} isn't running an agent`; cx.notify(); return; }
    const ck = this.commentsKey;
    this.busy = "send"; this.note = null; this.done = null;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["send", pane.terminal, message(list)]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        setComments(ck, []);
        this.done = `Sent ${list.length} comment${list.length === 1 ? "" : "s"} to ${pane.program?.name ?? pane.terminal}`;
        run("tab.select", { id: pane.tab });
        run("pane.focus", { pane: pane.pane });
      } catch (e) { this.note = `Send failed: ${e.message ?? e}`; }
      finally { this.busy = false; cx.notify(); }
    });
    cx.notify();
  }

  // Rows are drawn inside the virtual list's layout, where handlers throw: clicks come through clickItem.
  diffRow({ kind, number, text }, selected, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(C.hunk).text_color(C.hunkText).child(text);
    const tint = kind === "+" ? C.add : kind === "-" ? C.del : null, gutter = kind === "+" ? C.addGutter : kind === "-" ? C.delGutter : null;
    return h_flex().w_full().h(20).flex_none()
      .when(Boolean(tint), (e) => e.bg(tint)).when(selected, (e) => e.bg(t.accent + "40"))
      .child(div().w(44).h_full().pr(8).flex_none().flex().items_center().justify_end().text_color(t.dim)
        .when(Boolean(gutter), (e) => e.bg(gutter).text_color(t.foreground)).child(number === undefined ? "" : String(number)))
      .child(div().w(16).flex_none().text_center().text_color(t.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  commentRow(c, t) {
    return h_flex().w_full().h(20).flex_none().gap(6).pl(57).pr(8).items_center()
      .bg(C.comment).border_l(3).border_color(t.accent).text_color(t.foreground).font_family(settings().ui_font_family ?? "Geist")
      .child(div().flex_1().min_w(0).truncate().child(`› ${c.text}`));
  }

  // Click a line to select it, shift-click to extend, double-click to comment; click a comment to edit it.
  clickItem(key, cx) {
    if (!this.canComment()) return;
    const index = Number(key.slice(1));
    if (key[0] === "c") { this.editComment(index, cx); return; }
    const now = Date.now(), double = this.lastClick?.key === key && now - this.lastClick.at < 400;
    this.lastClick = { key, at: now };
    this.select(index, this.shift && !double, cx);
    if (double) this.startComment(cx);
  }

  // The open file's diff rows, each followed by the comments that end on it; comments whose line is gone go last.
  items() {
    const here = this.comments().map((c, index) => ({ c, index })).filter(({ c }) => c.path === this.open);
    const placed = new Set(), out = [];
    const lo = this.sel?.path === this.open ? Math.min(this.sel.a, this.sel.b) : -1, hi = this.sel?.path === this.open ? Math.max(this.sel.a, this.sel.b) : -2;
    this.rows.forEach((row, i) => {
      out.push({ row, i, selected: i >= lo && i <= hi });
      for (const h of here) if (!placed.has(h.index) && h.c.end?.kind === row.kind && h.c.end?.number === row.number) { placed.add(h.index); out.push(h); }
    });
    for (const h of here) if (!placed.has(h.index)) out.push(h);
    return out;
  }

  render(cx) {
    if (this.launcher) return div();
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const button = (id, label, on, action) => div().id(id).h(32).px(14).flex().items_center().rounded(8).bg(on ? t.solid : t.raised).text_color(on ? t.solid_foreground : t.dim).text_size(12).when(on, (e) => e.cursor_pointer()).on_click(action).child(label);
    const notes = (el) => el
      .when(this.limited, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).py(6).text_size(11).text_color(C.red).child(this.note)))
      .when(Boolean(this.done) && !this.note, (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.dim).child(this.done)));
    const root = v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.editing) { this.editing = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      });
    return tied() ? this.renderTab(root, t, button, notes, cx) : this.renderList(root, t, button, notes);
  }

  // The sidebar: mode, changed files, commit.
  renderList(root, t, button, notes) {
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const openPath = (shared("review.open") ?? {})[target().terminal];
    const perFile = {};
    for (const c of this.comments()) perFile[c.path] = (perFile[c.path] ?? 0) + 1;
    const modeButton = (id, label) => div().id(`mode-${id}`).px(6).py(1).rounded(4).text_size(10.5).cursor_pointer()
      .when(mode() === id, (e) => e.bg(t.selected).text_color(t.foreground))
      .when(mode() !== id, (e) => e.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
      .on_click(() => setShared("review.mode", id)).child(label);
    return notes(root
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Review"))
        .child(h_flex().gap(2).child(modeButton("branch", "Branch")).child(modeButton("uncommitted", "Uncommitted")))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(C.green).child(`+${add}`)).child(div().text_size(11).text_color(C.red).child(`−${del}`)))
      .when(Boolean(this.baseNote), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(this.baseNote)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
          const parts = f.path.split("/"), name = parts.pop();
          return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
            .when(openPath === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click(() => openTab(f.path))
            .child(div().w(14).text_size(11).font_semibold().text_color(STATUS[f.status] ?? t.dim).child(f.status))
            .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
            .when(Boolean(perFile[f.path]), (e) => e.child(div().px(4).rounded(4).bg(C.comment).text_size(10.5).text_color(t.foreground).child(`${perFile[f.path]} ›`)))
            .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(C.green).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(C.red).child(`−${f.del}`)));
        })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? (mode() === "branch" ? "No changes on this branch" : "No uncommitted changes") : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0())))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(button("commit", this.busy === "commit" ? "Committing…" : "Commit", enabled, (_e, cx) => this.commit(cx))));
  }

  // The review tab: one file's diff, comments and send.
  renderTab(root, t, button, notes, cx) {
    const want = (shared("review.open") ?? {})[tied()];
    if (want && want !== this.open && this.files.some((f) => f.path === want)) this.pick(want, cx);
    const can = this.canComment(), list = this.comments();
    const file = this.files.find((f) => f.path === this.open);
    const parts = (this.open ?? "").split("/"), name = parts.pop();
    const editingAt = this.editing ? (this.editing.index >= 0 ? list[this.editing.index]?.at : anchor(this.editing.path, this.editing.rows)) : null;
    // The virtual list keeps its first callbacks, so they read this.diffItems (live), never a render-local list.
    this.diffItems = this.items();
    return notes(root
      .on_modifiers_changed((e) => { this.shift = e.modifiers.shift; })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().font_semibold().flex_none().child(name || "No file")))
        .when(Boolean(file?.add), (e) => e.child(div().text_size(11).text_color(C.green).child(`+${file.add}`)))
        .when(Boolean(file?.del), (e) => e.child(div().text_size(11).text_color(C.red).child(`−${file.del}`)))
        .child(div().text_size(10.5).text_color(t.dim).child(mode() === "branch" ? "vs origin/main" : "uncommitted"))
        .when(!can, (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child("read-only · not an agent")))
        .when(can && list.length > 0, (e) => e.child(div().id("send").h(26).px(10).flex().items_center().rounded(6).bg(this.busy ? t.raised : t.solid).text_color(this.busy ? t.dim : t.solid_foreground).text_size(12).cursor_pointer()
          .on_click((_e, cx) => this.send(cx)).child(this.busy === "send" ? "Sending…" : `Send ${list.length} ⌘↵`))))
      .when(Boolean(this.baseNote), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(this.baseNote)))
      .child(div().flex_1().min_h(0).min_w(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.diffItems.length, 20, (i) => (this.diffItems[i]?.row ? `r${this.diffItems[i].i}` : `c${this.diffItems[i]?.index ?? i}`),
            (range) => this.diffItems.slice(range.start, range.end).map((it) => (it.row ? this.diffRow(it.row, it.selected, theme()) : this.commentRow(it.c, theme())))).size_full()
            .on_item_click((key, cx) => this.clickItem(key, cx)))))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.files.length, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : "No changes")))))
      .when(Boolean(this.editing), (e) => e.child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child(`Comment on ${editingAt ?? ""}`))
        .child(h_flex().gap(8)
          .child(div().id("comment-input").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.commentInput).h_full().text_size(12).text_color(t.foreground)))
          .when(this.editing?.index >= 0, (e) => e.child(button("comment-delete", "Delete", false, (_e, cx) => this.deleteComment(this.editing.index, cx))))
          .child(button("comment-save", "Save", true, (_e, cx) => this.saveComment(cx, false)))))));
  }
}
