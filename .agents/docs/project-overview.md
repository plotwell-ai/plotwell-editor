# Project Overview

plotwell is a professional screenplay editor and production planning platform with AI-powered writing assistance. It supports feature films and TV series production workflows.

## Tech Stack

Frontend:

- React 19 and TypeScript
- Vite
- React Router v7
- Tailwind CSS v4 and shadcn/ui components
- `plotwell-editor` local ProseMirror screenplay editor package
- TipTap for the document editor only
- Supabase auth and database

Backend:

- Node.js and Express
- TypeScript
- Supabase PostgreSQL
- Replicate API using `openai/gpt-oss-120b`
- Stripe payments

Real-time:

- WebSockets for collaboration
- Yjs CRDT for collaborative editing
- Server-Sent Events for progress tracking

## Repo Structure

```text
plotwell/
  plotwell-app/          React frontend
  plotwell-backend/      Node/Express backend
  plotwell-editor/       ProseMirror screenplay editor package
  plotwell-landing/      Marketing site
  plotwell-internal/     Internal tools
  plotwell-scripts/      Utility scripts
  plotwell-tools/        Supporting tools
  .agents/               Agent docs, role prompts, and skills
```

## Architecture Philosophy

- Feature-based organization by product domain.
- React Context plus hooks; no Redux, MobX, or Zustand.
- TypeScript strict mode.
- Real-time first for collaboration and presence.
- AI integrated into workflows rather than bolted on.

## Data Flow

```text
User action
  -> component/hooks
  -> context or local state
  -> API call with JWT
  -> backend route
  -> middleware chain
  -> Supabase
  -> response
  -> component update
```
