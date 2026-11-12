# In Herdr (when `$HC_TERMINAL_ID` is set)
- For parallel work, read `hc --skill` first, then start helpers with `hc run --bg --name <name> --cwd <worktree> claude "<task>. Report with hc send $HC_TERMINAL_ID when done or stuck."`
- Before opening a PR (not on every change): start both reviewers in parallel, then `hc wait --children all`:
  - `hc run --bg --name review-correctness --cwd <worktree> review-correctness "Report to $HC_TERMINAL_ID"`
  - `hc run --bg --name review-quality --cwd <worktree> review-quality "Report to $HC_TERMINAL_ID"`
  Fix their "Must fix" items, give me the quality findings as proposals, then `hc kill` and `hc rm` both reviewers.
