# Feature Guide

## Script Editor

Primary view: `plotwell-app/src/components/views/ScriptViewNew.tsx`.

The screenplay editor uses `@plotwell/editor` from `plotwell-editor/`, a standalone ProseMirror editor package. TipTap is used only for the document editor, not for screenplay editing.

Supported screenplay formats include Scene Heading, Action, Character, Dialogue, Parenthetical, Transition, Shot Description, Hook, Voiceover, and CTA.

Key files:

- `plotwell-editor/src/keymaps/index.ts`
- `plotwell-editor/src/schema/index.ts`
- `plotwell-editor/src/plugins/`
- `plotwell-editor/src/importers/`
- `plotwell-editor/src/exporters/`
- `plotwell-app/src/lib/editor/usePlotwellEditor.ts`
- `plotwell-app/src/lib/editor/collaboration.ts`
- `plotwell-app/src/types/scriptEditor.ts`

## Scene Headings And Locations

Scene heading generation, parsing, imports, and location creation must agree on
one canonical identity:

- Generate `INT. LOCATION - TIME` or `EXT. LOCATION - TIME`; use `INT./EXT.`
  only when a scene genuinely crosses both.
- Remove only recognized trailing time-of-day suffixes. Preserve sublocations
  such as `PISO - COCINA`.
- Compare locations through `plotwell-backend/src/utils/locationIdentity.ts`
  before inserting. AI extraction must also deduplicate its own response batch.
- Invalid AI JSON must fail without creating placeholder locations.
- The relationship map may coalesce historical duplicate rows for display, but
  destructive database consolidation requires an explicit merge workflow.

## Storyboard Editor

Primary view: `plotwell-app/src/components/views/StoryboardView.tsx`.

Features include panel CRUD, drag and drop ordering, image upload, AI image generation, AI panel generation from script, shot metadata, and optimistic UI updates.

Supporting components live in `plotwell-app/src/components/storyboard/`.

## Production Views

Main production views live under `plotwell-app/src/components/views/`:

- `BreakdownView.tsx` - scene breakdown.
- `CallSheetView.tsx` - call sheets.
- `CastCrewView.tsx` - cast and crew.
- `BudgetView.tsx` - budget analytics and tracking.
- `FilmingLocationsView.tsx` - filming locations.

## AI Chat Panel

Primary component: `plotwell-app/src/components/ai/AIChatPanel.tsx`.

Features include brainstorming conversations, project context awareness, scene generation integration, document generation triggers, and prompt templates.

## Collaboration

Backend service: `plotwell-backend/src/services/collaborationServer.ts`.

Uses Yjs CRDT for real-time editing, presence, comments, role-based access, and invitation workflow.

## TV Series

Tables: `seasons`, `episodes`.

Components: `EpisodeSelector`, `SeriesManager`.

Episode-aware sections include script editor, storyboard, and production breakdown.
