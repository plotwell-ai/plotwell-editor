# Quick Reference

## Frontend File Locations

All paths below are under `plotwell-app/src/`.

- Main views: `components/views/`.
- Layout: `components/layout/`.
- AI components: `components/ai/`.
- Script Doctor: `components/scriptDoctor/`.
- Location components: `components/locations/`.
- Keyboard shortcuts: `components/KeyboardShortcutsModal.tsx`.
- Billing: `components/billing/`.
- Base UI: `components/ui/`.
- Contexts: `contexts/`.
- Custom hooks: `hooks/`.
- Editor integration: `lib/editor/`.
- TipTap document editor config: `lib/tiptap/documentEditorConfig.ts`.
- Translations: `i18n/locales/`.
- Global styles: `index.css`, `screenplay.css`.

## Backend File Locations

All paths below are under `plotwell-backend/src/`.

- Server: `server.ts`.
- Auth middleware: `middleware/auth.ts`.
- Pricing middleware: `middleware/pricingMiddleware.ts`.
- AI routes: `routes/ai/`.
- Core routes: `routes/`.
- Services: `services/`.
- Database config: `config/database.ts`.
- Pricing plans: `config/pricingPlans.ts`.

Schema: `plotwell-backend/database_complete_schema.sql`.

## Commands

Frontend:

```bash
cd plotwell-app
npm run dev
npm run build
npm run lint
npm run env:dev
npm run env:prod
```

Backend:

```bash
cd plotwell-backend
npm run dev:local
npm run dev:dev
npm run dev:prod
npm run build
npm start
```

## Tooling Locations

- Standalone tools: `plotwell-tools/`.
- Demo recording automation: `plotwell-tools/demo-recordings/`.
- One-off generators: `plotwell-tools/generators/`.
- Shared generated media: `plotwell-tools/media/`.
- Screenplay fixtures: `plotwell-tools/fixtures/screenplays/`.

## API URL Configuration

The backend API URL is configured through Vercel environment variables, not rewrites in `vercel.json`.

Known Vercel setup:

| Vercel Project | Branch | `VITE_API_URL` |
| --- | --- | --- |
| `plotwell-dev` | `dev` | `https://plotwell-backend-dev.onrender.com` |
| `plotwell-prod` | `main` | `https://plotwell-backend-prod.onrender.com` |
