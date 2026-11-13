// Review's shared state, and the terminal a review is about.
// Shared keys: review.mode, review.open (terminal -> {path, at}: the file to jump to), review.tabs (terminal -> its
// review tab's name), review.comments / review.viewed (repo key -> comments / path -> diff fingerprint).
// PR facts (the base branch) come from the work badge's work.prs.
import { spaces, panes, focused, terminals, props, run, notify, shared, setShared, layout } from "herdr";

export const mode = () => shared("review.mode") ?? "branch";
export const tied = () => props()?.agent ?? null;
export const tabsOf = () => shared("review.tabs") ?? {};
const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
const branchOf = (terminal) => panes().find((p) => p.terminal === terminal)?.branch ?? null;

// The terminal a review is about: the tab's own; in the sidebar, the focused pane's, or a focused review tab's terminal.
export function target() {
  if (tied()) return { terminal: tied(), cwd: panes().find((p) => p.terminal === tied())?.cwd || props().cwd, on: props().on ?? null, branch: branchOf(tied()) };
  const f = focused(), pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane?.mod === "review") {
    const name = spaces().flatMap((s) => s.tabs).find((t) => t.id === pane.tab)?.name;
    const hit = Object.entries(tabsOf()).find(([, v]) => v.name === name);
    if (hit) return { terminal: hit[0], cwd: panes().find((p) => p.terminal === hit[0])?.cwd || hit[1].cwd, on: hit[1].on ?? null, branch: branchOf(hit[0]) };
  }
  const space = spaces().find((s) => s.active), terminal = pane?.terminal ?? f?.terminal ?? null;
  const on = f?.pane === null ? machineOf(f.terminal) : space?.machine ?? null;
  return { terminal, cwd: pane?.cwd || f?.cwd || space?.folder, on, branch: branchOf(terminal) };
}

// The branch's PR, from the work badge's poll (your open PRs and last week's merged ones).
// shortcut: PRs you didn't open aren't there, so their review compares with origin/main; ask gh per branch if that matters.
export function prFor(branch) {
  if (!branch || /^(main|master)$/.test(branch)) return null;
  const all = shared("work.prs");
  return [...(all?.open ?? []), ...(all?.merged ?? [])].find((p) => p.branch === branch) ?? null;
}

// What a review shows depends on these; any change starts it over. The PR's base is in it, so a stacked PR's
// review compares with its base branch from the first load.
export const key = () => { const t = target(); return JSON.stringify([t.cwd, t.on, mode(), prFor(t.branch)?.base ?? null]); };

// Per-repo maps in shared state (an empty value removes the repo's entry).
const getIn = (name, ck, fallback) => (shared(name) ?? {})[ck] ?? fallback;
function setIn(name, ck, value, empty) {
  const all = { ...(shared(name) ?? {}) };
  if (empty) delete all[ck]; else all[ck] = value;
  setShared(name, all);
}
export const commentsOf = (ck) => getIn("review.comments", ck, []);
export const setComments = (ck, list) => setIn("review.comments", ck, list, !list.length);
export const viewedOf = (ck) => getIn("review.viewed", ck, {});
export const setViewed = (ck, map) => setIn("review.viewed", ck, map, !Object.keys(map).length);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

// On screen: the sidebar while the panel shows Review; a review tab while it is the active space's active tab.
export function onScreen() {
  if (!tied()) { const root = layout(); return !find(root, "panel")?.hidden && find(root, "panel-body")?.active === "changes"; }
  const name = tabsOf()[tied()]?.name;
  return Boolean(spaces().find((s) => s.active)?.tabs.find((t) => t.name === name)?.active);
}

// Opens the terminal's review tab, or shows it, at `path` when given, with the file list beside it.
// Entries for terminals that are gone are dropped on the way.
export function openTab(path) {
  const t = target();
  if (!t.terminal) { notify({ title: "Focus a terminal first", body: "A review tab belongs to the terminal it was opened from.", level: "warning" }); return; }
  const live = new Set(terminals().filter((k) => k.state === "live").map((k) => k.address));
  const alive = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => live.has(k)));
  // No path (cmd-shift-g): drop an old sidebar click, or a new tab would jump to it.
  const opens = alive(shared("review.open"));
  if (path) opens[t.terminal] = { path, at: Date.now() }; else delete opens[t.terminal];
  setShared("review.open", opens);
  const tabs = alive(tabsOf()), space = spaces().find((s) => s.active);
  const existing = tabs[t.terminal] && space?.tabs.find((x) => x.name === tabs[t.terminal].name);
  if (existing) run("tab.select", { id: existing.id });
  else {
    const pane = panes().find((p) => p.terminal === t.terminal), tab = space?.tabs.find((x) => x.id === pane?.tab);
    let name = `Review · ${tab?.named ? tab.name : pane?.program?.name ?? t.terminal}`;
    // shortcut: tab names tie review tabs to terminals, so renaming a review tab unties it; tie by pane id if Herdr exposes one.
    if (Object.entries(tabs).some(([k, v]) => k !== t.terminal && v.name === name)) name += ` (${t.terminal})`;
    tabs[t.terminal] = { name, cwd: t.cwd, on: t.on };
    run("tab.new", { space: space?.id, name, mod: "review", props: { agent: t.terminal, cwd: t.cwd, on: t.on } });
  }
  setShared("review.tabs", tabs);
  run("layout.select", { stack: "panel-body", child: "changes" });
  run("layout.show", { id: "panel" });
}
