// Work: your GitHub PRs and Linear issues, each tied to the session working on it. One mod, by props:
// - view "badge" (status bar, always on screen): polls GitHub every 2 min and Linear every 5 and posts PR alerts;
//   it is the one source of PR facts: other mods read work.prs (label, tone, base) and work.needsYou;
// - view "prs" / "linear" (right panel stack children): the lists, from what the badge stores.
// The tab bar (my-tabs) owns showing and hiding the panes.
// Shared: work.prs, work.issues, work.snap (last PR states, for alerts), work.sent (review threads sent to sessions),
// work.needsYou (any open PR needs you).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { panes, spaces, focused, run, exec, hc, home, theme, shared, setShared, notify, props } from "herdr";

// Settings: change to yours.
const REPOS_DIR = "Developer/repos"; // under your home: where your git clones live (Clean up finds merged PRs' worktrees there)

const C = { green: "#3fb950", red: "#f85149", amber: "#d29922", blue: "#388bfd" };
const REPOS = () => `${home()}/${REPOS_DIR}`;
const FAILED = new Set(["FAILURE", "ERROR"]);
const activeSpace = () => spaces().find((s) => s.active)?.id;
const ago = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };

// The Linear key a branch starts with, after any "<name>/" prefix: bekzatamirbay/aei-2371-x -> AEI-2371.
export const issueKey = (branch) => /^([a-z]+-\d+)(?:-|$)/i.exec((branch ?? "").replace(/^[^/]+\//, ""))?.[1]?.toUpperCase() ?? null;
// "owner/name" from a GitHub remote URL (ssh or https).
export const ghRepo = (url) => /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
if (ghRepo("git@github.com:org/repo.git") !== "org/repo" || ghRepo("https://github.com/org/repo") !== "org/repo" || ghRepo("/tmp/x") !== null) throw new Error("ghRepo self-check failed");

// ---- GitHub

// Your open PRs and the ones merged in the last 7 days, in one call.
const PR_QUERY = `query($open: String!, $merged: String!) {
  open: search(query: $open, type: ISSUE, first: 50) { nodes { ...pr } }
  merged: search(query: $merged, type: ISSUE, first: 30) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft state headRefName headRefOid baseRefName mergedAt updatedAt
  repository { name nameWithOwner }
  reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewThreads(first: 100) { nodes { id isResolved } }
}`;

async function fetchPRs() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const r = await exec("gh", ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", "open=is:pr is:open author:@me archived:false", "-f", `merged=is:pr is:merged author:@me merged:>=${since}`]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  const d = JSON.parse(r.stdout).data;
  const pr = (n) => {
    const threads = n.reviewThreads.nodes.filter((t) => !t.isResolved).map((t) => t.id);
    const p = {
      number: n.number, title: n.title, url: n.url, draft: n.isDraft, state: n.state, branch: n.headRefName, head: n.headRefOid, base: n.baseRefName,
      repo: n.repository.name, owner: n.repository.nameWithOwner, review: n.reviewDecision, updated: n.updatedAt, merged: n.mergedAt,
      ci: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null, threads, unresolved: threads.length,
    };
    return { ...p, ...prBadge(p) };
  };
  return { at: Date.now(), open: d.open.nodes.filter((n) => n.number).map(pr), merged: d.merged.nodes.filter((n) => n.number).map(pr) };
}

// What every view shows for a PR: "#12 ✓ approved". tone "bad" (CI failed, changes requested) is red, "good" (approved) green.
export function prBadge(p) {
  if (p.state !== "OPEN") return { label: `#${p.number} ${p.state.toLowerCase()}`, tone: null };
  const ci = !p.ci ? "" : p.ci === "SUCCESS" ? " ✓" : FAILED.has(p.ci) ? " ✗" : " •";
  const review = p.review === "APPROVED" ? " approved" : p.review === "CHANGES_REQUESTED" ? " changes requested" : "";
  return { label: `#${p.number}${ci}${review}`, tone: FAILED.has(p.ci) || p.review === "CHANGES_REQUESTED" ? "bad" : p.review === "APPROVED" ? "good" : null };
}
if (prBadge({ number: 1, state: "OPEN", ci: "FAILURE", review: "APPROVED" }).label !== "#1 ✗ approved" || prBadge({ number: 1, state: "OPEN", ci: "FAILURE" }).tone !== "bad"
  || prBadge({ number: 2, state: "MERGED" }).label !== "#2 merged" || prBadge({ number: 3, state: "OPEN", review: "APPROVED" }).tone !== "good") throw new Error("prBadge self-check failed");

// What changed since the last poll that deserves a notification. A PR seen for the first time alerts nothing.
export function alerts(prev, next) {
  const out = [];
  for (const p of next.open) {
    const o = prev[p.url];
    if (!o) continue;
    if (FAILED.has(p.ci) && p.ci !== o.ci) out.push({ p, body: "CI failed", level: "error" });
    if (p.review !== o.review && (p.review === "APPROVED" || p.review === "CHANGES_REQUESTED")) out.push({ p, body: p.review === "APPROVED" ? "Approved" : "Changes requested", level: p.review === "APPROVED" ? "info" : "warning" });
    if (p.unresolved > o.unresolved) out.push({ p, body: `New review comments: ${p.unresolved} unresolved`, level: "info" });
  }
  for (const p of next.merged) if (prev[p.url]?.state === "OPEN") out.push({ p, body: "Merged", level: "info" });
  return out;
}
const snapshot = (d) => Object.fromEntries([...d.open, ...d.merged].map((p) => [p.url, { ci: p.ci, review: p.review, unresolved: p.unresolved, state: p.state }]));
{
  const p = { url: "u", ci: "FAILURE", review: "APPROVED", unresolved: 2, state: "OPEN" };
  const got = alerts({ u: { ci: "SUCCESS", review: null, unresolved: 1, state: "OPEN" } }, { open: [p], merged: [] }).map((a) => a.body);
  if (got.join("|") !== "CI failed|Approved|New review comments: 2 unresolved" || alerts({}, { open: [p], merged: [] }).length
    || alerts({ u: { state: "OPEN" } }, { open: [], merged: [{ ...p, state: "MERGED" }] })[0]?.body !== "Merged"
    || issueKey("bekzatamirbay/aei-2371-x") !== "AEI-2371" || issueKey("devin/1794-x") !== null) throw new Error("work self-check failed");
}

// Polls and stores PRs; the badge also posts alerts and moves the snapshot on.
async function refreshPRs(withAlerts) {
  try {
    const d = await fetchPRs();
    if (withAlerts) {
      const prev = shared("work.snap");
      // A click shows the PR pane (never hides it: my-tabs' showprs).
      if (prev) for (const a of alerts(prev, d)) notify({ title: `#${a.p.number} ${a.p.title}`.slice(0, 90), body: `${a.body} · ${a.p.repo}`, level: a.level, action: { name: "my-tabs.showprs" } });
      setShared("work.snap", snapshot(d));
    }
    setShared("work.prs", d);
    // Sent threads of PRs no longer open are forgotten.
    const sent = shared("work.sent") ?? {}, keep = Object.fromEntries(d.open.filter((p) => sent[p.url]).map((p) => [p.url, sent[p.url]]));
    if (Object.keys(keep).length !== Object.keys(sent).length) setShared("work.sent", keep);
    publishNeeds();
  } catch (e) {
    setShared("work.prs", { open: [], merged: [], ...(shared("work.prs") ?? {}), error: String(e.message ?? e).slice(0, 300) });
  }
}

// Unresolved review threads not yet sent to the PR's session (work.sent: PR url -> thread ids sent).
const unsent = (p) => {
  if (!p.threads) return p.unresolved; // stored before thread ids were
  const sent = new Set((shared("work.sent") ?? {})[p.url] ?? []);
  return p.threads.filter((id) => !sent.has(id)).length;
};
const needsYou = (p) => FAILED.has(p.ci) || p.review === "CHANGES_REQUESTED" || unsent(p) > 0;
// work.needsYou: the tab bar's red dot. Written whenever PRs or sent threads change.
function publishNeeds() {
  const v = (shared("work.prs")?.open ?? []).some(needsYou);
  if (shared("work.needsYou") !== v) setShared("work.needsYou", v);
}

const THREADS_QUERY = `query($o: String!, $n: String!, $num: Int!) { repository(owner: $o, name: $n) { pullRequest(number: $num) {
  reviewThreads(first: 100) { nodes { id isResolved path line originalLine comments(first: 20) { nodes { author { login } body } } } } } } }`;

export function threadsMessage(p, threads) {
  const lines = threads.filter((t) => !t.isResolved).map((t) => {
    const [first, ...replies] = t.comments.nodes, line = t.line ?? t.originalLine;
    return [`- ${t.path}${line ? `:${line}` : ""} @${first?.author?.login ?? "?"}: ${first?.body?.trim() ?? ""}`,
      ...replies.map((c) => `  - @${c.author?.login ?? "?"}: ${c.body.trim()}`)].join("\n");
  });
  return [`Unresolved review comments on PR #${p.number} (${p.url}):`, ...lines].join("\n");
}
if (threadsMessage({ number: 7, url: "U" }, [{ isResolved: false, path: "a.py", line: 3, comments: { nodes: [{ author: { login: "x" }, body: "why? " }, { author: { login: "me" }, body: "ok" }] } }, { isResolved: true, path: "b", comments: { nodes: [] } }])
  !== "Unresolved review comments on PR #7 (U):\n- a.py:3 @x: why?\n  - @me: ok") throw new Error("threadsMessage self-check failed");

// ---- Linear

const ISSUES_QUERY = `query { viewer { assignedIssues(first: 100, orderBy: updatedAt, filter: { state: { type: { in: ["started", "unstarted"] } } }) {
  nodes { identifier title url branchName state { name type } project { name url } team { key } } } } }`;
// The key stays in Keychain and reaches curl through its stdin, never on a command line.
const LINEAR_SH = `key=$(security find-generic-password -s herdr-linear -w 2>/dev/null) || exit 3
printf 'header = "Authorization: %s"\\n' "$key" | curl -sS --max-time 20 -K - -H 'Content-Type: application/json' --data "$1" https://api.linear.app/graphql`;

async function refreshIssues() {
  try {
    const r = await exec("sh", ["-c", LINEAR_SH, "sh", JSON.stringify({ query: ISSUES_QUERY })]);
    if (r.code === 3) { setShared("work.issues", { at: Date.now(), nokey: true, issues: [] }); return; }
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    const d = JSON.parse(r.stdout);
    if (d.errors) throw new Error(d.errors[0].message);
    setShared("work.issues", { at: Date.now(), issues: d.data.viewer.assignedIssues.nodes });
  } catch (e) {
    setShared("work.issues", { issues: [], ...(shared("work.issues") ?? {}), error: String(e.message ?? e).slice(0, 300) });
  }
}

async function openLinear(url) {
  const r = await exec("open", ["-a", "Linear", url]).catch(() => null);
  if (r?.code !== 0) await exec("open", [url]);
}

// ---- Sessions

// The terminal pane on a matching branch (agents first), with its tab and space.
function sessionWhere(match) {
  const p = panes().filter((x) => x.terminal && x.branch && match(x.branch)).sort((a, b) => Boolean(b.status) - Boolean(a.status))[0];
  if (!p) return null;
  for (const s of spaces()) { const tab = s.tabs.find((t) => t.id === p.tab); if (tab) return { pane: p, tab, space: s }; }
  return null;
}
function goTo(s) { run("space.select", { id: s.space.id }); run("tab.select", { id: s.tab.id }); run("pane.focus", { pane: s.pane.pane }); }
// The name the agents list shows: the tab's own name, else the program's live title (Claude's session title).
const sessionName = (s) => {
  const prog = s.pane.program?.name, live = (s.pane.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const telling = live && live !== prog && !/^[~/]/.test(live) && !live.includes("@");
  return (s.tab.name === prog || !s.tab.named) && telling ? live : s.tab.name || prog || s.pane.terminal;
};

// branch -> worktree folder (the main checkout included).
async function worktrees(repo) {
  const r = await exec("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  const out = {};
  let path = null;
  for (const l of r.stdout.split("\n")) {
    if (l.startsWith("worktree ")) path = l.slice(9);
    else if (l.startsWith("branch refs/heads/")) out[l.slice(18)] = path;
  }
  return out;
}

const slug = (url) => /\/project\/([^/?#]+)/.exec(url ?? "")?.[1] ?? null;
// In a space linked to a Linear project (cmd-l's link), only that project's issues; elsewhere all of yours.
function visibleIssues(data) {
  const want = slug((shared("linear.projects") ?? {})[activeSpace()]), all = data?.issues ?? [];
  return { want, issues: want ? all.filter((i) => slug(i.project?.url) === want) : all };
}

async function sendComments(p, s) {
  try {
    const [o, n] = p.owner.split("/");
    const r = await exec("gh", ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `o=${o}`, "-f", `n=${n}`, "-F", `num=${p.number}`]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    const open = JSON.parse(r.stdout).data.repository.pullRequest.reviewThreads.nodes.filter((t) => !t.isResolved);
    const before = new Set((shared("work.sent") ?? {})[p.url] ?? []), fresh = open.filter((t) => !before.has(t.id));
    if (!fresh.length) { notify({ title: `#${p.number}: nothing new to send`, body: `All ${open.length} unresolved comments were already sent.`, level: "info" }); return; }
    // A blocked agent refuses it (hc send without --force).
    const sent = await hc(["send", s.pane.terminal, threadsMessage(p, fresh)]);
    if (sent.code !== 0) throw new Error((sent.stderr || sent.stdout).trim());
    setShared("work.sent", { ...(shared("work.sent") ?? {}), [p.url]: open.map((t) => t.id) });
    publishNeeds();
    notify({ title: `Sent ${fresh.length} comment${fresh.length === 1 ? "" : "s"} from #${p.number}`, body: `To ${sessionName(s)}`, level: "info" });
    goTo(s);
  } catch (e) {
    notify({ title: `Couldn't send #${p.number}'s comments`, body: String(e.message ?? e).slice(0, 300), level: "error" });
  }
}

// ---- Clean up after a merge: check, ask in the PR's row, then close the worktree's tabs, remove it, delete the branch.

const inDir = (dir) => panes().filter((x) => x.cwd === dir || x.cwd?.startsWith(`${dir}/`));

// What the confirmation shows, or a reason to refuse: an agent still busy there, uncommitted changes, local commits
// the merged PR doesn't have, or a tab to close that is its space's last (spaces close by hand).
async function cleanupPlan(p, dir) {
  const repo = `${REPOS()}/${p.repo}`, git = (args, cwd = dir) => exec("git", ["-C", cwd, ...args], { timeout: 120000 });
  if (inDir(dir).some((x) => x.status === "working" || x.status === "blocked")) throw new Error("An agent in it is still working or waiting for you");
  const status = await git(["status", "--porcelain", "--ignored"]);
  if (status.code !== 0) throw new Error((status.stderr || status.stdout).trim());
  const lines = status.stdout.split("\n").filter(Boolean);
  if (lines.some((l) => !l.startsWith("!! "))) throw new Error(`Uncommitted changes in ${dir.replace(home(), "~")}`);
  await git(["fetch", "origin", `pull/${p.number}/head`], repo);
  const tip = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (tip !== p.head && (await git(["merge-base", "--is-ancestor", "HEAD", p.head])).code !== 0) throw new Error("The local branch has commits the merged PR doesn't have");
  const tabIds = [...new Set(inDir(dir).map((x) => x.tab))];
  for (const s of spaces()) {
    const mine = s.tabs.filter((t) => tabIds.includes(t.id));
    if (mine.length && mine.length >= s.tabs.length) throw new Error(`Its session is the last tab in "${s.name}": close that by hand first`);
  }
  return { repo, dir, tabIds, ignored: lines.map((l) => l.slice(3)) };
}

async function cleanup(p, plan) {
  try {
    for (const id of plan.tabIds) run("tab.close", { id, confirmed: true });
    // No --force: git still refuses if anything but ignored files changed since the plan (ignored files go, as listed).
    const rm = await exec("git", ["-C", plan.repo, "worktree", "remove", plan.dir], { timeout: 120000 });
    if (rm.code !== 0) throw new Error((rm.stderr || rm.stdout).trim());
    await exec("git", ["-C", plan.repo, "branch", "-D", p.branch]);
    // The review mod's comments and Viewed marks for that worktree go too (its key for a local repo root).
    const ck = `comments:${JSON.stringify([null, plan.dir])}`;
    for (const key of ["review.comments", "review.viewed"]) {
      const all = { ...(shared(key) ?? {}) };
      if (ck in all) { delete all[ck]; setShared(key, all); }
    }
    notify({ title: `Cleaned up #${p.number}`, body: `Removed ${plan.dir.replace(home(), "~")} and ${p.branch}`, level: "info" });
  } catch (e) {
    notify({ title: `Didn't clean up #${p.number}`, body: String(e.message ?? e).slice(0, 300), level: "warning" });
  }
}

// ---- Panes

export default class Work extends View {
  init(_props, cx) {
    this.view = props()?.view ?? null;
    this.trees = {}; this.busy = {}; this.confirm = null;
    if (this.view !== "badge") return;
    cx.spawn(async () => { await refreshPRs(true); await refreshIssues(); });
    cx.timer.every(120000, () => { refreshPRs(true); });
    cx.timer.every(300000, () => { refreshIssues(); });
  }

  render(cx) {
    const t = theme();
    if (this.view === "badge") return this.renderBadge(t);
    const root = v_flex().id(`work-${this.view}`).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    return this.view === "linear" ? this.renderLinear(root, t, cx) : this.renderPRs(root, t, cx);
  }

  chip(t, id, label, color, onClick) {
    return div().id(id).flex_none().px(5).h(18).flex().items_center().rounded(4).text_size(11).text_color(color ?? t.muted)
      .when(Boolean(onClick), (e) => e.cursor_pointer().border_1().border_color(t.border).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .child(label);
  }

  header(t, title, data, refresh, key) {
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(title))
      .child(div().flex_1().text_size(11).text_color(t.dim).child(data?.at ? `updated ${ago(data.at)}` : ""))
      .child(this.chip(t, `refresh-${key}`, this.busy[key] ? "…" : "Refresh", null, (cx) => {
        if (this.busy[key]) return;
        this.busy[key] = true; cx.notify();
        cx.spawn(async (cx) => { await refresh(); this.busy[key] = false; cx.notify(); });
      }));
  }

  list(id, children) {
    return div().flex_1().min_h(0).child(v_flex().id(id).size_full().overflow_y_scrollbar().p(6).gap(2).children(children));
  }

  section(t, label) {
    return div().px(8).pt(10).pb(4).text_size(11).font_semibold().text_color(t.dim).child(label);
  }

  // ---- PR pane

  ciMark(t, ci) {
    if (!ci) return div().w(14).flex_none();
    const [mark, color] = ci === "SUCCESS" ? ["✓", C.green] : FAILED.has(ci) ? ["✗", C.red] : ["•", C.amber];
    return div().w(14).flex_none().text_color(color).font_bold().child(mark);
  }

  // Merged PRs' worktrees, looked up again whenever the PR list changes.
  loadTrees(data, cx) {
    if (!data?.at || this.treesAt === data.at) return;
    this.treesAt = data.at;
    cx.spawn(async (cx) => {
      const trees = {};
      for (const repo of new Set(data.merged.map((p) => p.repo))) trees[repo] = await worktrees(`${REPOS()}/${repo}`).catch(() => ({}));
      this.trees = trees;
      cx.notify();
    });
  }

  // Clean up's first click: check, then ask in the row (what goes, including ignored files), or say why not.
  askCleanup(p, dir, cx) {
    cx.spawn(async (cx) => {
      try { this.confirm = { url: p.url, plan: await cleanupPlan(p, dir) }; }
      catch (e) { notify({ title: `Can't clean up #${p.number}`, body: String(e.message ?? e).slice(0, 300), level: "warning" }); }
      cx.notify();
    });
  }

  confirmStrip(t, p) {
    const { plan } = this.confirm, shown = plan.ignored.slice(0, 4).join(", ");
    const more = plan.ignored.length > 4 ? ` and ${plan.ignored.length - 4} more` : "";
    return v_flex().mt(4).ml(20).p(8).gap(6).rounded(6).border_1().border_color(C.red).text_size(11).text_color(t.muted)
      .on_click((_e, cx) => cx.stop_propagation())
      .child(div().child(`Removes ${plan.dir.replace(home(), "~")} and branch ${p.branch}${plan.tabIds.length ? `, closes ${plan.tabIds.length} tab${plan.tabIds.length === 1 ? "" : "s"}` : ""}.`))
      .when(plan.ignored.length > 0, (e) => e.child(div().child(`Also deletes ignored files: ${shown}${more}.`)))
      .child(h_flex().gap(6)
        .child(this.chip(t, `clean-yes-${p.url}`, "Clean up", C.red, () => { this.confirm = null; cleanup(p, plan); }))
        .child(this.chip(t, `clean-no-${p.url}`, "Cancel", null, (cx) => { this.confirm = null; cx.notify(); })));
  }

  prRow(t, p, merged) {
    const s = sessionWhere((b) => b === p.branch), dir = merged ? this.trees[p.repo]?.[p.branch] : null;
    const review = p.review === "APPROVED" ? ["approved", C.green] : p.review === "CHANGES_REQUESTED" ? ["changes requested", C.red] : null;
    // Comments go only to an agent: pasted into a plain shell, every line would run as a command.
    const agent = s?.pane.status ? s : null;
    return v_flex().id(`pr-${p.url}`).flex_none().px(8).py(6).gap(3).rounded(7).cursor_pointer().hover((e) => e.bg(t.hover))
      .on_click(() => { exec("open", [p.url]).catch(() => null); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(merged ? div().w(14).flex_none().text_color(C.blue).child("⇣") : this.ciMark(t, p.ci))
        .child(div().flex_none().text_color(t.dim).text_size(12).child(`#${p.number}`))
        .child(div().flex_1().min_w(0).truncate().child(p.title)))
      .child(h_flex().pl(20).gap(5).items_center().min_w(0).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`${p.repo} · ${p.branch.replace(/^[^/]+\//, "")}`))
        .when(p.draft, (e) => e.child(this.chip(t, `draft-${p.url}`, "draft")))
        .when(Boolean(review) && !merged, (e) => e.child(this.chip(t, `rv-${p.url}`, review[0], review[1])))
        .when(p.unresolved > 0 && !merged, (e) => e.child(!agent
          ? this.chip(t, `un-${p.url}`, `${p.unresolved} unresolved`, C.amber)
          : unsent(p) > 0
            ? this.chip(t, `send-${p.url}`, `Send ${unsent(p)} new comment${unsent(p) === 1 ? "" : "s"}`, C.amber, () => sendComments(p, agent))
            : this.chip(t, `sent-${p.url}`, `✓ ${p.unresolved} sent`, C.green)))
        .when(Boolean(s), (e) => e.child(this.chip(t, `go-${p.url}`, `→ ${sessionName(s)}`.slice(0, 28), t.foreground, () => goTo(s))))
        .when(Boolean(dir) && this.confirm?.url !== p.url, (e) => e.child(this.chip(t, `clean-${p.url}`, "Clean up…", null, (cx) => this.askCleanup(p, dir, cx)))))
      .when(this.confirm?.url === p.url, (e) => e.child(this.confirmStrip(t, p)));
  }

  // A folder's GitHub repo ("owner/name") from its origin remote; null outside a repo. Looked up once per folder.
  repoOf(cwd, cx) {
    this.remotes ??= new Map();
    if (!this.remotes.has(cwd)) {
      this.remotes.set(cwd, undefined);
      cx.spawn(async (cx) => {
        const r = await exec("git", ["-C", cwd, "remote", "get-url", "origin"]).catch(() => null);
        this.remotes.set(cwd, r?.code === 0 ? ghRepo(r.stdout.trim()) : null);
        cx.notify();
      });
    }
    return this.remotes.get(cwd);
  }

  // The focused terminal's repo decides the list: in a repo or its worktree, that repo's PRs; elsewhere all of them.
  // Its branch's PR (or "no PR yet") goes first, under "This pane".
  renderPRs(root, t, cx) {
    const data = shared("work.prs");
    this.loadTrees(data, cx);
    const f = focused();
    if (f?.cwd) this.focus = { cwd: f.cwd, branch: panes().find((p) => p.pane === f.pane)?.branch ?? null };
    const repo = this.focus ? this.repoOf(this.focus.cwd, cx) : null, branch = this.focus?.branch;
    const inRepo = (p) => !repo || p.owner.toLowerCase() === repo.toLowerCase();
    const mine = branch && !/^(main|master)$/.test(branch) ? [...(data?.open ?? []), ...(data?.merged ?? [])].find((p) => p.branch === branch) ?? null : null;
    // Needing you first: CI failed, changes requested, comments not sent yet; then the most recently updated.
    const need = (p) => (FAILED.has(p.ci) ? 4 : 0) + (p.review === "CHANGES_REQUESTED" ? 2 : 0) + (unsent(p) > 0 ? 1 : 0);
    const open = (data?.open ?? []).filter((p) => inRepo(p) && p !== mine).sort((a, b) => need(b) - need(a) || (b.updated ?? "").localeCompare(a.updated ?? ""));
    const merged = (data?.merged ?? []).filter((p) => inRepo(p) && p !== mine);
    const here = branch && !/^(main|master)$/.test(branch) && data ? [
      this.section(t, `This pane · ${branch.replace(/^[^/]+\//, "")}`),
      mine ? this.prRow(t, mine, mine.state !== "OPEN") : div().px(8).py(4).text_size(12).text_color(t.dim).child("No PR for this branch yet"),
    ] : [];
    return root
      .child(this.header(t, repo ? `PRs · ${repo.split("/").pop()}` : "Pull requests", data, () => refreshPRs(false), "prs"))
      .when(Boolean(data?.error), (e) => e.child(div().px(12).py(6).text_size(11).text_color(C.red).child(data.error)))
      .child(this.list("work-prs", [
        ...(!data ? [div().p(8).text_color(t.dim).child("Loading…")] : []),
        ...here,
        ...(data ? [this.section(t, `Open · ${open.length}`)] : []),
        ...open.map((p) => this.prRow(t, p, false)),
        ...(merged.length ? [this.section(t, `Merged · last 7 days · ${merged.length}`)] : []),
        ...merged.map((p) => this.prRow(t, p, true)),
      ]));
  }

  // ---- Linear pane

  issueRow(t, i) {
    const s = sessionWhere((b) => issueKey(b) === i.identifier), started = i.state.type === "started";
    return v_flex().id(`is-${i.identifier}`).flex_none().px(8).py(6).gap(3).rounded(7).cursor_pointer().hover((e) => e.bg(t.hover))
      .on_click(() => { openLinear(i.url); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().size(8).mx(3).flex_none().rounded(4).when(started, (e) => e.bg(C.amber)).when(!started, (e) => e.border(1.5).border_color(t.dim)))
        .child(div().flex_none().text_color(t.dim).text_size(12).child(i.identifier))
        .child(div().flex_1().min_w(0).truncate().child(i.title)))
      .child(h_flex().pl(20).gap(5).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(i.state.name))
        .when(Boolean(s), (e) => e.child(this.chip(t, `go-${i.identifier}`, `→ ${sessionName(s)}`.slice(0, 28), t.foreground, () => goTo(s)))));
  }

  renderLinear(root, t) {
    const data = shared("work.issues"), { want, issues } = visibleIssues(data);
    const groups = new Map();
    for (const i of issues) {
      const k = i.project?.name ?? "No project";
      groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => (a === "No project") - (b === "No project") || a.localeCompare(b));
    const title = want ? `Linear · ${issues[0]?.project?.name ?? spaces().find((s) => s.active)?.name ?? "this project"}` : "Linear";
    const noKey = v_flex().p(10).gap(8).text_size(12).text_color(t.muted)
      .child(div().child("Add a Linear API key: in Linear, Settings → Security & access → Personal API keys → New key. Then run this in a terminal and paste the key:"))
      .child(div().p(8).rounded(6).bg(t.raised).font_family("JetBrains Mono").text_size(11).text_color(t.foreground).child("security add-generic-password -s herdr-linear -a linear -w"))
      .child(div().child("Then press Refresh."));
    return root
      .child(this.header(t, title, data, () => refreshIssues(), "linear"))
      .when(Boolean(data?.error), (e) => e.child(div().px(12).py(6).text_size(11).text_color(C.red).child(data.error)))
      .child(data?.nokey ? noKey : this.list("work-linear", [
        ...(!data ? [div().p(8).text_color(t.dim).child("Loading…")] : []),
        ...(data && !data.nokey && !issues.length ? [div().p(8).text_color(t.dim).child(want ? "None of your open issues are in this project." : "No open issues assigned to you.")] : []),
        ...ordered.flatMap(([name, list]) => [this.section(t, `${name} · ${list.length}`), ...[...list].sort((a, b) => (b.state.type === "started") - (a.state.type === "started")).map((i) => this.issueRow(t, i))]),
      ]));
  }

  // ---- Status bar badge

  renderBadge(t) {
    const prs = shared("work.prs"), iss = shared("work.issues"), open = prs?.open ?? [];
    const failing = open.filter((p) => FAILED.has(p.ci)).length, changes = open.filter((p) => p.review === "CHANGES_REQUESTED").length;
    const comments = open.filter((p) => unsent(p) > 0).length;
    const part = (id, onClick) => h_flex().id(id).gap(6).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(onClick);
    return h_flex().size_full().px(10).gap(14).items_center().justify_end().text_size(11).text_color(t.dim)
      .child(part("badge-prs", () => run("my-tabs.prs")).tooltip("Pull requests (⌘⇧I)")
        .child(div().child(prs ? `${open.length} PRs` : "PRs …"))
        .when(failing > 0, (e) => e.child(div().text_color(C.red).child(`✗ ${failing}`)))
        .when(changes > 0, (e) => e.child(div().text_color(C.red).child(`${changes} changes`)))
        .when(comments > 0, (e) => e.child(div().text_color(C.amber).child(`${comments} with new comments`)))
        .when(Boolean(prs?.error), (e) => e.child(div().text_color(C.red).child("!"))))
      .child(part("badge-linear", () => run("my-tabs.linear")).tooltip("Linear (⌘⇧L)")
        .child(div().child(iss?.nokey ? "Linear: add a key" : iss ? `${visibleIssues(iss).issues.length} issues` : "Linear …"))
        .when(Boolean(iss?.error), (e) => e.child(div().text_color(C.red).child("!"))));
  }
}
