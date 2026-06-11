# plotwell Agent Guide

Last updated: June 1, 2026

This is the lightweight entrypoint for AI coding agents working in this repo. Keep it short. Put durable project knowledge in `.agents/docs/` and reusable role prompts in `.agents/agents/`.

## Start Here

1. Read only the docs relevant to the task.
2. Prefer existing repo patterns over new abstractions.
3. Keep edits scoped to the requested app, service, or doc.
4. Update the relevant docs when architectural decisions or conventions change.

## Project Map

plotwell is a professional screenplay editor and production planning platform with AI writing assistance.

| Area | Path | Notes |
| --- | --- | --- |
| Frontend app | `plotwell-app/` | React 19, TypeScript, Vite, React Router v7, Tailwind v4, shadcn/ui |
| Backend API | `plotwell-backend/` | Node.js, Express, TypeScript, Supabase, Stripe, Replicate |
| Editor package | `plotwell-editor/` | ProseMirror screenplay editor package |
| Landing site | `plotwell-landing/` | Public marketing site |
| Internal tools | `plotwell-internal/` | Internal/admin tooling |
| Standalone tools | `plotwell-tools/` | Public tools, generators, demo recordings, fixtures, and shared media |
| Agent harness | `.agents/` | Docs, role prompts, and skills |

## Non-Negotiables

- Internal navigation uses React Router `navigate()`, never `window.location.href` except external URLs.
- Dashboard navigation uses `useProjectNavigation`.
- Frontend imports use the `@/` alias.
- User-facing text uses i18n keys through `useTranslation()` and updates both English and Spanish locale files.
- Edit forms, settings, and detail views use `SidePanel`, not dialogs. Dialogs are for quick confirmations.
- The brand is `plotwell` in lowercase unless grammar requires otherwise.
- Projects use `projects.name` for the project name. `projects.title` is the screenplay cover-page title.
- Backend data access uses the Supabase client, not a PostgreSQL pool.
- Mutations include ownership or collaboration access checks.
- Projects are soft-deleted with `deleted = TRUE`; do not hard delete user projects.
- AI routes track successful usage with `trackOpenAIUsageInRoute`.
- Verbose AI logs are guarded with `DEBUG_AI`; errors and warnings remain unconditional.

## Read The Relevant Doc

| Task | Read |
| --- | --- |
| Frontend feature, routing, state, i18n | `.agents/docs/frontend.md` |
| Backend route, middleware, services | `.agents/docs/backend.md` |
| Supabase schema, queries, ownership | `.agents/docs/database.md` |
| UI styling, responsive layout, components | `.agents/docs/design-system.md` |
| AI routes, prompts, usage, model routing | `.agents/docs/ai.md` |
| Script editor, storyboard, production views | `.agents/docs/features.md` |
| Commands, env vars, file locations | `.agents/docs/quick-reference.md` |
| Documentation rules and source docs | `.agents/docs/documentation-maintenance.md` |

The full doc index is in `.agents/docs/README.md`.

## Role Prompts

Reusable specialist prompts live in `.agents/agents/`:

- `reviewer.md` - code review for security, TypeScript, and plotwell conventions.
- `db-auditor.md` - Supabase query and database performance audit.
- `security-audit.md` - deep auth, payment, API, and secret review.
- `dead-code.md` - unused exports, orphan files, and unused dependencies.
- `typescript-auditor.md` - TypeScript, Node, Vite, package config, and deprecation review.
- `test-runner.md` - concise TypeScript/test execution reporting.

## Existing Skills

Local skills live under `.agents/skills/`. Use them when the task matches their description, especially deployment, React performance, composition patterns, React Native, and UI/accessibility review.

## Common Commands

```bash
# Frontend
cd plotwell-app
npm run dev
npm run build
npm run lint

# Backend
cd plotwell-backend
npm run dev:local
npm run build
npm start
```

## Worktree Care

This repo may have unrelated local edits. Do not revert, overwrite, or clean up changes you did not make unless explicitly asked. If a file you need is already modified, read it carefully and work with the current state.
