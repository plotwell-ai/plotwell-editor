# Agent Docs Index

These docs replace the old single long `CLAUDE.md`. They are organized so an agent can load only the context needed for the current task.

| File | Purpose |
| --- | --- |
| `project-overview.md` | Product, tech stack, repo structure, and architecture philosophy |
| `frontend.md` | React app routing, components, hooks, state, imports, and i18n |
| `backend.md` | Express API patterns, middleware, responses, logging, and route docs |
| `database.md` | Supabase schema conventions, query rules, ownership, soft delete, performance |
| `design-system.md` | Brand, colors, typography, component usage, SidePanel, responsive rules |
| `ai.md` | AI routes, context building, usage tracking, DEBUG_AI, model integration |
| `features.md` | Script editor, storyboard, production views, AI chat, collaboration, TV series |
| `practices.md` | Cross-cutting best practices and common pitfalls |
| `quick-reference.md` | Commands, env vars, file locations, API URL configuration |
| `documentation-maintenance.md` | Documentation update policy and detailed doc map |

## Suggested Reading

- Small frontend fix: `frontend.md`, then `design-system.md` if UI changes.
- Backend route change: `backend.md`, `database.md`, and the relevant backend service doc.
- AI feature: `ai.md`, `backend.md`, and any prompt/service files being edited.
- Script editor work: `features.md` plus `plotwell-app/EDITOR_SYSTEM.md` if present.
- Broad refactor or release cleanup: `practices.md`, then invoke the relevant role prompt from `.agents/agents/`.
