# Agent Harness

This folder contains the repo-specific AI harness for plotwell.

## Layout

| Path | Purpose |
| --- | --- |
| `../AGENTS.md` | Short root bootstrap for coding agents |
| `docs/` | Topical project memory split from the old long `CLAUDE.md` |
| `agents/` | Reusable specialist role prompts |
| `skills/` | Installed local skills and their supporting files |

## Maintenance

- Keep `AGENTS.md` compact. It should answer "what must every agent know immediately?"
- Put detailed references in `docs/`.
- Put reusable role behavior in `agents/`.
- Put tool-like workflows, scripts, and larger reference packs in `skills/`.
- When a convention changes, update the smallest relevant file and then update `docs/README.md` if the index changes.

## Role Prompts

- `agents/reviewer.md` - general code review.
- `agents/db-auditor.md` - Supabase query and database performance review.
- `agents/security-audit.md` - auth, payment, API, and secret review.
- `agents/dead-code.md` - unused code and dependency review.
- `agents/typescript-auditor.md` - TypeScript, Node, Vite, and package config review.
- `agents/test-runner.md` - concise test execution reporting.
