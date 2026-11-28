# Agents guide: a2w-control

This repo's own rules are in `CLAUDE.md`. Read it first: they apply to every agent, not only Claude Code. TENET runs as **tenet-core**: a journal, a session board and delegation. There's no Pi runtime and no `tenet_*` tools.

## How to work here
- **Your own worktree.** Work only in the worktree or branch you were given, and don't touch other checkouts. In a sandbox (a queue or delegate run), you have no network and can write only inside the worktree. Don't commit, push, merge or deploy: the runner commits your changes as one branch for review.
- **Prove it.** Run the checks below before you finish. If one can't run in your sandbox, say exactly which one and why. Never weaken a test to make it pass.
- **Other sessions.** Other Claude and Codex sessions may be working in this repo. If `tenet-core` is on your PATH, `tenet-core session list --repo .` shows them and the files they've claimed. Don't edit a claimed file. Say so in your summary instead.
- **Finish with a summary:** what changed and why, the checks you ran and their results, and anything left or risky. The runner journals your branch, so you don't need to write a journal entry.
- **Never:** touch production data, live devices, deploys, secrets or `.env` files, or another repo.

## Checks
Run the repo's test command (see `package.json` or `CLAUDE.md`). Say which one you ran.

## Code
- Every code file gets a `@purpose` header comment.
