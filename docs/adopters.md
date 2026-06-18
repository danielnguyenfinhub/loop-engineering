# Adopters & community setups

Forks and stars mean people are trying this in their own stacks. If you run a loop from this repo (or adapted from it), add yourself here via PR.

## How to list your project

Open a PR that adds a row to the table below:

| Field | What to include |
|-------|-----------------|
| **Project** | Repo link or product name |
| **Pattern(s)** | e.g. Daily Triage + Issue Triage |
| **Tool** | Grok, Claude Code, Codex, Cursor, Windsurf, GitHub Actions, mixed |
| **Level** | L1 / L2 / L3 (honest) |
| **Notes** | One line — what worked or what broke |

## Adopters

| Project | Pattern(s) | Tool | Level | Notes |
|---------|------------|------|-------|-------|
| [loop-engineering](https://github.com/cobusgreyling/loop-engineering) (this repo) | Daily Triage, Changelog Drafter, audit dogfood | GitHub Actions + Grok | L3 | Reference implementation — `loop-audit` on every PR; readiness score 100 |
| [loop-engineering](https://github.com/cobusgreyling/loop-engineering) (maintainer) | Post-Merge Cleanup | Grok + GitHub Actions | L1→L2 | Off-peak scan; verifier caught doc/API drift — see [story](../stories/post-merge-cleanup-honest-win.md) |
| [loop-engineering](https://github.com/cobusgreyling/loop-engineering) (maintainer) | Issue Triage + Daily Triage | Grok | L1 | Issue queue feeder: propose labels only week one; pairs with morning `STATE.md` triage |
| [loop-engineering](https://github.com/cobusgreyling/loop-engineering) (maintainer) | PR Babysitter, Dependency Sweeper | Grok / Claude Code | L2 | Assisted fixes in worktrees; human gate on merges; patch-only deps |

*Your project here — see [CONTRIBUTING.md](../CONTRIBUTING.md).*

## Show & tell

Prefer chat over a PR? Post in [GitHub Discussions → Show your loop](https://github.com/cobusgreyling/loop-engineering/discussions/categories/show-your-loop) with:

1. Which pattern you picked and why
2. Your first `/loop` or scheduler command
3. One surprise (good or bad)

Failure reports are first-class — see [stories/](../stories/).