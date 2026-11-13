// Git reads for Review, and the pure helpers both views use. No view state here.
import { exec, readTextFile } from "herdr";

// GitHub-dark style diff colors.
export const C = { add: "#2ea04333", addGutter: "#2ea0434d", del: "#f8514933", delGutter: "#f851494d", hunk: "#388bfd1f", hunkText: "#8fb8ff",
  comment: "#388bfd2e", green: "#3fb950", red: "#f85149", amber: "#d29922" };
export const STATUS = { A: C.green, D: C.red, U: C.red, M: C.amber };

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const letter = (s) => (s[0] === "U" ? "U" : s[0] === "D" ? "D" : s[0] === "A" ? "A" : "M");
const MAX_FILE = 5000, MAX_TOTAL = 50000, MAX_NEW = 200, MAX_FILES = 1000;
// Folded until clicked: lockfiles, snapshots, minified files (and any diff over 1,000 lines).
const BULKY = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|[^/]*\.lock|[^/]*\.snap|[^/]*\.min\.(js|css))$/;

// Splits `git diff --no-renames` output by file: "diff --git a/<p> b/<p>" has the same path twice.
// shortcut: paths git still quotes (control characters, quotes) get no diff text; parse the quoting if that shows up.
export function splitDiff(raw) {
  const out = {};
  let cur = null;
  for (const line of raw.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("diff --git a/")) {
      const rest = line.slice(11), n = (rest.length - 5) / 2;
      cur = Number.isInteger(n) && rest.slice(n + 2, n + 5) === " b/" ? rest.slice(2, n + 2) : null;
      if (cur !== null) out[cur] = [];
    } else if (cur !== null) out[cur].push(line);
  }
  return out;
}

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

// The message an agent gets. A comment's later lines are indented under its bullet.
export function message(comments) {
  return ["Review comments:", ...comments.map((c) => `- ${c.at}${c.quote ? ` \`${c.quote}\`` : ""} — ${c.text.replace(/\n/g, "\n  ")}`)].join("\n");
}

// A short fingerprint of a file's diff, so "viewed" ends when the file changes.
const fingerprint = (lines) => {
  let h = 5381;
  for (const l of lines) { for (let i = 0; i < l.length; i++) h = (h * 33 + l.charCodeAt(i)) | 0; h = (h * 33 + 10) | 0; }
  return `${(h >>> 0).toString(36)}:${lines.length}`;
};

if (anchor("a.py", [{ kind: "+", number: 4 }, { kind: "+", number: 6 }]) !== "a.py:4-6"
  || anchor("a.py", [{ kind: "-", number: 9 }]) !== "a.py:9 (removed)"
  || message([{ at: "a.py:4", quote: "x = 1", text: "why?" }, { at: "b.py (whole file)", quote: "", text: "split\nthis" }])
    !== "Review comments:\n- a.py:4 `x = 1` — why?\n- b.py (whole file) — split\n  this"
  || JSON.stringify(splitDiff("diff --git a/x y b/x y\n--- a/x y\n+++ b/x y\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/z b/z\n@@ -0,0 +1 @@\n+c\n"))
    !== JSON.stringify({ "x y": ["--- a/x y", "+++ b/x y", "@@ -1 +1 @@", "-a", "+b"], z: ["@@ -0,0 +1 @@", "+c"] })
  || fingerprint(["ab", "c"]) === fingerprint(["a", "bc"])) throw new Error("review self-check failed");

// git at root, read-only; with `index`, against that index file instead of the repo's own (Since sent).
const gitAt = (root, on, index) => (args) => index
  ? exec("env", [`GIT_INDEX_FILE=${index}`, "git", ...READ, ...args], { cwd: root, on })
  : exec("git", [...READ, ...args], { cwd: root, on });

// "path -> {add, del, binary}" from `--numstat -z` results, summed.
function numstats(results) {
  const stats = {};
  for (const result of results) {
    if (result.code !== 0) throw new Error(result.stderr);
    for (const entry of result.stdout.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
      stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
    }
  }
  return stats;
}
// Files from `--name-status -z` output (status and path alternate).
function nameStatus(stdout, stats) {
  const parts = stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < parts.length && out.length < MAX_FILES; i += 2) {
    if (parts[i + 1]) out.push({ path: parts[i + 1], status: letter(parts[i]), fresh: false, ...(stats[parts[i + 1]] ?? { add: 0, del: 0 }) });
  }
  return out;
}

// Since sent: on each send the review saves the worktree as it was (`git add -A` into a copy of the index, untracked
// files included) to this file in the worktree's git folder, so removing the worktree removes it too.
const SENT = "herdr-review-sent.index";
export async function saveSent(root, on) {
  const r = await exec("sh", ["-c", `f=$(git rev-parse --path-format=absolute --git-path ${SENT}) && i=$(git rev-parse --path-format=absolute --git-path index) || exit 1
rm -f "$f.new"; cp "$i" "$f.new" 2>/dev/null
GIT_INDEX_FILE="$f.new" git -c core.fsmonitor=false add -A && mv -f "$f.new" "$f"`], { cwd: root, on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "git add failed");
}

// What changed since the last send: the worktree against the saved index, and files that weren't there then.
async function sentFiles(root, on, hasHead) {
  const index = (await gitAt(root, on)(["rev-parse", "--path-format=absolute", "--git-path", SENT])).stdout.trim();
  if ((await exec("test", ["-f", index], { on })).code !== 0) return { root, files: [], hasHead, nothingSent: true };
  const git = gitAt(root, on, index);
  const [names, stat, others] = await Promise.all([git(["diff", "--name-status", "-z", "--no-renames"]), git(["diff", "--numstat", "-z", "--no-renames"]),
    git(["ls-files", "--others", "--exclude-standard", "-z"])]);
  for (const r of [names, others]) if (r.code !== 0) throw new Error(r.stderr);
  const added = others.stdout.split("\0").filter(Boolean);
  const files = [...nameStatus(names.stdout, numstats([stat])), ...added.slice(0, MAX_FILES).map((path) => ({ path, status: "A", fresh: true, add: 0, del: 0 }))];
  return { root, files, hasHead, index, limited: added.length > MAX_FILES };
}

// The changed files at cwd. Branch mode: everything since this branch left its PR's base branch (stacked PRs), else
// origin's default; uncommitted mode, or no base found: against HEAD; since-sent mode: see sentFiles. Untracked files
// are always in. Returns { root: null } outside a repo.
export async function changedFiles({ cwd, on, branchMode, sinceSent, prBase }) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  if (top.code !== 0) return { root: null };
  const root = top.stdout.trim(), git = gitAt(root, on);
  if (sinceSent) return sentFiles(root, on, (await git(["rev-parse", "--verify", "HEAD"])).code === 0);
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  if (status.code !== 0) throw new Error(status.stderr);
  const hasHead = (await git(["rev-parse", "--verify", "HEAD"])).code === 0;
  let base = null, baseName = null;
  if (branchMode && hasHead) {
    for (const ref of [...(prBase ? [`origin/${prBase}`] : []), "origin/HEAD", "origin/main"]) {
      const r = await git(["merge-base", "HEAD", ref]);
      if (r.code === 0) { base = r.stdout.trim(); baseName = ref === "origin/HEAD" ? "origin/main" : ref; break; }
    }
  }
  const against = base ?? "HEAD";
  const stats = numstats(hasHead ? [await git(["diff", against, "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])]);
  const files = [], entries = status.stdout.split("\0").filter(Boolean);
  for (const entry of entries.slice(0, MAX_FILES)) {
    const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
    if (base && !fresh) continue; // branch mode: tracked files come from the diff against the base below
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
    files.push({ path, status: s, fresh, ...(stats[path] ?? { add: 0, del: 0 }) });
  }
  if (base) {
    const names = await git(["diff", base, "--name-status", "-z", "--no-renames"]);
    if (names.code !== 0) throw new Error(names.stderr);
    files.unshift(...nameStatus(names.stdout, stats));
  }
  return { root, files, hasHead, against, base, baseName, limited: entries.length > MAX_FILES };
}

// Every file's diff as rows, a header row first per file. Returns null when nothing changed since `sig`.
// With `index` (since sent), the worktree against that index.
export async function loadDiffs({ root, on, files, hasHead, against, index }, sig) {
  const direct = (f) => f.fresh || (!hasHead && f.status === "A");
  let raw = "";
  if (files.some((f) => !direct(f))) {
    const r = await gitAt(root, on, index)(["-c", "core.quotePath=false", "diff", ...(!index && hasHead ? [against] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"]);
    if (r.code !== 0) throw new Error(r.stderr);
    raw = r.stdout;
  }
  const fresh = files.filter(direct).slice(0, MAX_NEW);
  const texts = await Promise.all(fresh.map((f) => readTextFile(`${root}/${f.path}`, { on }).catch(() => null)));
  const nextSig = [raw, ...texts, ...files.map((f) => f.path)].join("\u0001");
  if (nextSig === sig) return null;
  const parsed = splitDiff(raw), text = new Map(fresh.map((f, n) => [f.path, texts[n]]));
  const rows = [], auto = new Set();
  let total = 0, cut = false;
  for (const f of files) {
    let lines;
    if (direct(f)) {
      const t = text.get(f.path);
      if (t === undefined) lines = ["Not loaded: too many new files"];
      else if (t === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (t.includes("\0")) lines = ["Binary file · no text diff"];
      else { f.add = countLines(t); lines = [`@@ -0,0 +1,${f.add} @@`, ...t.slice(0, 400000).replace(/\n$/, "").split("\n").map((l) => `+${l}`)]; }
    } else {
      const all = parsed[f.path] ?? [], first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [f.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (lines.length > 1000 || BULKY.test(f.path)) auto.add(f.path);
    if (lines.length > MAX_FILE) lines = [...lines.slice(0, MAX_FILE), `… cut at ${MAX_FILE.toLocaleString()} lines`];
    if (total + lines.length > MAX_TOTAL) { lines = [`Not shown: this review is over ${MAX_TOTAL.toLocaleString()} lines`]; cut = true; }
    total += lines.length;
    rows.push({ kind: "file", path: f.path, file: f, size: lines.length, hash: fingerprint(lines) });
    for (const r of diffRows(lines.map((l) => (l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l)))) { r.path = f.path; rows.push(r); }
  }
  return { sig: nextSig, rows, auto, cut };
}
