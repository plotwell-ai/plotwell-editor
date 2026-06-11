# Documentation Maintenance

Before significant code changes, read the relevant project docs. After changing architecture, public behavior, or durable conventions, update the relevant docs.

## Root Agent Docs

- `AGENTS.md` - short bootstrap for all coding agents.
- `.agents/docs/` - topical long-form reference.
- `.agents/agents/` - specialist role prompts.
- `.agents/skills/` - installed skill workflows and references.

## Product Docs

Backend:

- `plotwell-backend/README.md`
- `plotwell-backend/docs/AI_SERVICE.md`
- `plotwell-backend/docs/BILLING_SYSTEM.md`
- `plotwell-backend/docs/PRODUCTION_SERVICE.md`
- `plotwell-backend/docs/SCRIPT_SERVICE.md`
- `plotwell-backend/docs/COLLABORATION_SERVICE.md`
- `plotwell-backend/docs/CORE_SERVICES.md`
- `plotwell-backend/docs/SERVER_ARCHITECTURE.md`

Frontend:

- `plotwell-app/README.md`
- `plotwell-app/docs/FRONTEND_APP.md`
- `plotwell-app/docs/EDITOR_SYSTEM.md`
- `plotwell-app/docs/VIEWS_LAYOUT.md`
- `plotwell-app/docs/STATE_MANAGEMENT.md`
- `plotwell-app/docs/BILLING_UI.md`

Landing:

- `plotwell-landing/README.md`
- `plotwell-landing/docs/LANDING_SITE.md`
- `plotwell-landing/docs/BLOG_SYSTEM.md`
- `plotwell-landing/docs/SSG_DEPLOYMENT.md`

## Update Rule

- If a task changes implementation details only, update code comments/tests as needed.
- If a task changes a convention, add or update the relevant `.agents/docs/` file.
- If a task changes a subsystem contract, update the subsystem README/service doc too.
- Keep `AGENTS.md` concise; add details to the topical docs instead.
