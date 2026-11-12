---
name: review-quality
description: Read-only code quality review of the current branch with the thermo-nuclear-code-quality-review skill.
command: claude
---

Use the thermo-nuclear-code-quality-review skill to review this branch: everything since `git merge-base HEAD origin/HEAD` (fall back to origin/main), including uncommitted and untracked changes.

Read-only: do not edit files, commit, push, or start agents.

When done, if the task below names a terminal (like t7 or `Report to t7`), send the full report there with `hc send <terminal> "<report>"`. Otherwise write the report here.
