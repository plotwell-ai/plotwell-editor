# plotwell Production Service

**Last Updated**: April 5, 2026

---

## Overview

The production service handles film and TV series production planning: scene breakdown, cast/crew management, shooting schedule, budget tracking, call sheet generation, and exports. It sits on top of the script editor -- the script is always the source of truth for scene data.

---

## Architecture

### Key Files

| Layer | File | Purpose |
|-------|------|---------|
| **Router** | `routes/production/index.ts` | Aggregates all sub-routers |
| **Routes** | `routes/production/analysis.ts` | AI-powered script analysis, budget optimization |
| **Routes** | `routes/production/scenes.ts` | Scene CRUD, budget items, sync, locations |
| **Routes** | `routes/production/cast.ts` | Cast CRUD, scene/day assignments |
| **Routes** | `routes/production/crew.ts` | Crew CRUD, day assignments |
| **Routes** | `routes/production/schedule.ts` | Schedule, day settings, call sheets |
| **Routes** | `routes/production/exports.ts` | CSV/HTML export endpoints |
| **Helpers** | `routes/production/helpers.ts` | Shared utilities, access checks, project context |
| **Middleware** | `middleware/productionPrerequisitesMiddleware.ts` | Script/scene prerequisite checks |
| **Service** | `services/productionSyncServiceSimple.ts` | Script-to-production scene sync |
| **Service** | `services/productionAnalysisService.ts` | AI analysis, scene card management |
| **Service** | `services/productionExportService.ts` | CSV/HTML export generation |
| **Service** | `services/sceneBreakdownExportService.ts` | Scene breakdown + DOOD HTML exports |
| **Service** | `services/sceneIdentityService.ts` | SHA256 scene fingerprinting |
| **Service** | `services/castService.ts` | Cast business logic |
| **Service** | `services/scheduleService.ts` | Schedule + AI optimization |
| **Service** | `services/callSheetService.ts` | Call sheet generation |

### Database Tables

| Table | Purpose |
|-------|---------|
| `production_scene_data` | Scene production metadata (shoot date, status, complexity, budget) |
| `scene_cards` | AI-analyzed scene metadata (characters, locations, time of day, props) |
| `scene_change_log` | Tracks sync changes for user review |
| `production_cast` | Cast members (character_name, actor_name, rate_per_day, season_id) |
| `production_cast_scenes` | Cast-to-scene assignments |
| `production_cast_days` | Cast-to-shooting-day assignments |
| `production_crew` | Crew members (name, role, department, rate_per_day, season_id) |
| `production_crew_days` | Crew-to-shooting-day assignments |
| `production_budgets` | Budget line items (category, item, quantity, rate in cents) |
| `production_assets` | Project-level asset registry (name, department, quantity, status, notes) |
| `scene_breakdown_items` | Asset-to-scene link table (FK to `production_scene_data` + `production_assets`) |
| `production_locations` | Filming locations with addresses and costs |
| `shooting_day_settings` | Per-day settings (general_call_time, department_call_times JSON) |
| `production_schedules` | Scene-to-date assignments |

---

## Prerequisites Middleware

Production features require three conditions before use:

1. **Project has a script** -- at least one script record exists
2. **Script has parsed scenes** -- scene count > 0
3. **Production data is initialized** -- production_scene_data rows exist (created by first sync)

Three middleware variants:

- `checkProductionPrerequisites` -- blocks with 403 if prerequisites not met
- `attachProductionStatus` -- attaches status to `req.productionStatus` but does not block (for GET endpoints)
- `requireSyncedScenes` -- blocks if no production scenes exist (for "Fill with AI" and similar)

The status object includes: `hasScript`, `hasScenes`, `sceneCount`, `productionSceneCount`, `syncStatus`, `canUseProduction`.

---

## Scene Sync

**Script is the source of truth.** Production scenes are derived from script scenes via sync.

### Scene Identity

Each scene gets a stable ID via SHA256 hash of a fingerprint:

```
{ heading, location, time_of_day, int_ext, characters (sorted), firstLineOfAction (100 chars) }
```

This allows detecting when a scene has moved (renumbered) vs. when it is genuinely new.

### Sync Algorithm

`syncProductionWithScript()` categorizes each script scene into one of four buckets:

1. **Existing (by scene_number)** -- update `last_synced_at` timestamp
2. **Moved (by content hash)** -- scene exists but at a different number; update `scene_number`
3. **New** -- batch insert with default values (complexity: medium, status: planning)
4. **Archived** -- production scenes no longer in script get `status: 'archived'`

Users can review changes via `resolveChanges()`: approve (re-sync), reject (mark as `manual`), or delete (archive).

### Sync Endpoints

- `GET /sync-status/:projectId` -- preview what would change
- `POST /sync/:projectId` -- execute sync
- `POST /resolve-changes/:projectId` -- apply user decisions from review modal

---

## Cast Management

### CRUD

Standard create/read/update/delete on `production_cast`. Each cast member has: `character_name`, `actor_name`, `category` (lead, supporting, minor, background, extra), `rate_per_day` (cents), `actor_contact` (JSON: email, phone, agent, agency, emergency_contact), `notes`, `availability_dates`, optional `season_id` and `character_id`.

### Bulk Import

`POST /cast/:projectId/bulk-from-characters` creates cast entries from the project's character database, skipping duplicates.

### Scene Assignments

`POST /cast/:castId/scenes` assigns a cast member to specific scenes via `production_cast_scenes`. Call sheets auto-link cast to scenes by matching `character_name` against scene character lists.

### Day Assignments

`POST /cast/:castId/days` replaces all day assignments (delete-then-insert pattern). Accepts either a simple `dates` array or a detailed `dayAssignments` array with call/wrap times.

### TV Series

GET endpoints accept `?season_id=` to filter cast by season.

---

## Crew Management

### CRUD

Standard create/read/update/delete on `production_crew`. Fields: `name`, `role`, `department`, `rate_per_day` (cents), `rate_per_hour`, `contact` (JSON), `notes`.

Crew list is ordered by `department` then `role`. GET response includes `assignedDays` array (fetched in a single batch query, not N+1).

### Day Assignments

Same pattern as cast: `POST /crew/:crewId/days` with delete-then-insert. `DELETE /crew/:crewId/days/:shootDate` removes a single day.

### TV Series

Crew members can be scoped to a season via `season_id`. GET endpoints accept `?season_id=` filter; when absent, returns crew with `season_id IS NULL` (project-level).

---

## Schedule

### Manual Assignment

`PUT /schedule/scene/:sceneId` assigns a scene to a specific `shootDate`. `PUT /schedule/:projectId/reorder` bulk-reorders scenes.

### AI Optimization

`POST /schedule/:projectId/optimize` uses AI to suggest an optimal shooting order based on locations, cast availability, time of day, and complexity.

### Shooting Day Settings

Each shooting day can have per-day settings via `shooting_day_settings`:

- `general_call_time` (default: "07:00")
- `department_call_times` (JSON object, e.g., `{ "Camera": "06:30", "Hair/Makeup": "05:30" }`)
- `estimated_wrap_time`, `notes`, `primary_location`

Settings are upserted on `(project_id, shoot_date)`.

---

## Call Sheets

### Generation

`GET /call-sheet/:projectId/:shootDate` auto-generates a call sheet by combining:

1. Scenes scheduled for that date (from `production_scene_data`)
2. Cast assigned to that date (from `production_cast_days`), auto-linked to scenes by character name
3. Crew assigned to that date (from `production_crew_days`)
4. Day settings (call times, location, notes)

### Shooting Days List

`GET /call-sheet/:projectId/days` returns all dates that have scenes scheduled (for the day picker).

### Export

- `GET /call-sheet/:projectId/:shootDate/export/csv` -- CSV download
- `GET /call-sheet/:projectId/:shootDate/export/html` -- HTML (for PDF via browser print)
- `GET /call-sheet/:projectId/:shootDate/text` -- formatted plain text

---

## AI Analysis

### Script Analysis

`POST /analyze-script` sends script content to AI and produces:

- **Scene cards** (`scene_cards` table) -- structured metadata per scene: characters, locations, props, vehicles, special effects, time of day, complexity, estimated shoot days
- **Budget items** (`production_budgets` table) -- categorized line items with quantity and rate

### Fill with AI

`POST /fill-with-ai` enhances existing production scenes with AI-generated metadata. Requires synced scenes (uses `requireSyncedScenes` middleware). Includes full AI middleware chain: `extractUserId`, `addPricingService`, `checkAIGenerationLimit`, `trackAIUsage`.

### Other AI Endpoints

- `POST /optimize-budget` -- AI budget optimization with target percentage and categories
- `POST /budget-scenarios` -- generate alternative budget scenarios
- `POST /budget-health` -- analyze budget health against industry benchmarks
- `POST /optimize-schedule` -- AI schedule optimization
- `POST /suggest-locations` -- AI location suggestions based on scene requirements
- `POST /generate-shots` -- AI shot list generation for a scene

---

## Exports

| Endpoint | Format | Content |
|----------|--------|---------|
| `GET /:projectId/cast/export/csv` | CSV | Cast list with rates and contact |
| `GET /:projectId/locations/export/csv` | CSV | Production locations |
| `GET /:projectId/schedule/export/csv` | CSV | Full shooting schedule |
| `GET /call-sheet/:projectId/:shootDate/export/csv` | CSV | Call sheet for one day |
| `GET /call-sheet/:projectId/:shootDate/export/html` | HTML | Call sheet (printable) |
| `GET /:projectId/breakdown/export/html` | HTML | Scene breakdown report |
| `GET /:projectId/dood/export/html` | HTML | Day Out of Days report |

Breakdown and DOOD exports accept `?episode_id=` for TV series filtering.

---

## API Endpoints

All endpoints are under `/api/production` and require `requireAuth`.

### Analysis (AI)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/analyze-script` | AI script analysis -> scene cards + budget |
| POST | `/generate-shots` | AI shot list for a scene |
| POST | `/optimize-budget` | AI budget optimization |
| POST | `/budget-scenarios` | AI budget scenario generation |
| POST | `/budget-health` | AI budget health analysis |
| POST | `/optimize-schedule` | AI schedule optimization |
| POST | `/suggest-locations` | AI location suggestions |
| POST | `/fill-with-ai` | AI-enhance existing scenes (rate limited) |
| GET | `/analysis-history/:projectId` | Past AI analyses |
| DELETE | `/analysis/:analysisId` | Delete an analysis |
| GET | `/history/:projectId` | Production analysis history |

### Scenes & Data

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/data/:projectId` | Get all production data (scene cards + budget) |
| GET | `/scenes/:projectId` | Get production scenes |
| PATCH | `/scenes/:sceneId` | Update production scene fields |
| PUT | `/scene-card/:sceneId` | Update scene card |
| DELETE | `/scene-card/:sceneId` | Delete scene card |
| POST | `/scene-card` | Create scene card |
| GET | `/budget/:projectId` | Get budget items |
| POST | `/budget-item` | Create budget item |
| PUT | `/budget-item/:itemId` | Update budget item |
| DELETE | `/budget-item/:itemId` | Delete budget item |
| GET | `/preview-script-scenes/:projectId` | Preview scenes before import |
| POST | `/import-from-script/:projectId` | Import scenes from script |
| POST | `/import-to-storyboard/:projectId` | Push scenes to storyboard |
| POST | `/create-schedule` | Create schedule from analysis |
| PUT | `/projects/:projectId/settings` | Update project production settings |
| GET | `/character-links/:projectId` | Get character-to-cast links |
| GET | `/dashboard/:projectId` | Production dashboard summary |
| GET | `/assets/:projectId` | Get project assets (`?department=`) |
| POST | `/assets` | Create asset |
| PUT | `/assets/:id` | Update asset |
| DELETE | `/assets/:id` | Delete asset |
| GET | `/breakdown-items/:sceneDataId` | Get assets linked to a scene |
| POST | `/breakdown-items` | Link asset to scene (upsert) |
| DELETE | `/breakdown-items/:id` | Unlink asset from scene |

### Sync

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/sync-status/:projectId` | Check sync status |
| POST | `/sync/:projectId` | Execute sync |
| POST | `/resolve-changes/:projectId` | Apply user review decisions |
| POST | `/scenes/:sceneId/lock` | Lock scene |
| POST | `/scenes/:sceneId/unlock` | Unlock scene |

### Cast

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/cast` | Create cast member |
| GET | `/cast/:projectId` | List cast (`?season_id=`) |
| GET | `/cast/:projectId/:castId` | Get cast member with days |
| PUT | `/cast/:castId` | Update cast member |
| DELETE | `/cast/:castId` | Delete cast member |
| POST | `/cast/:castId/scenes` | Assign to scenes |
| DELETE | `/cast/:castId/scenes/:sceneId` | Remove from scene |
| GET | `/scene/:sceneId/cast` | Get cast for scene |
| POST | `/cast/:castId/days` | Assign to shooting days |
| GET | `/cast-by-day/:projectId/:shootDate` | Get cast for a day |
| POST | `/cast/:projectId/bulk-from-characters` | Bulk import from characters |
| PUT | `/cast/:castId/scenes/:sceneId/call-time` | Update cast call time |
| GET | `/episode/:episodeId` | Cast assigned to episode (TV series) |
| POST | `/episode-assign` | Assign cast to episode |
| DELETE | `/episode-unassign` | Remove cast from episode |

### Crew

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/crew` | Create crew member |
| GET | `/crew/:projectId` | List crew (`?season_id=`) |
| GET | `/crew/:projectId/:crewId` | Get crew member with days |
| PUT | `/crew/:crewId` | Update crew member |
| DELETE | `/crew/:crewId` | Delete crew member |
| POST | `/crew/:crewId/days` | Assign to shooting days |
| DELETE | `/crew/:crewId/days/:shootDate` | Remove from day |
| GET | `/crew-by-day/:projectId/:shootDate` | Get crew for a day |
| GET | `/episode/:episodeId` | Crew assigned to episode (TV series) |
| POST | `/episode-assign` | Assign crew to episode |
| DELETE | `/episode-unassign` | Remove crew from episode |

### Schedule & Call Sheets

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/schedule/:projectId` | Get full schedule |
| PUT | `/schedule/scene/:sceneId` | Assign scene to date |
| PUT | `/schedule/:projectId/reorder` | Bulk reorder scenes |
| POST | `/schedule/:projectId/optimize` | AI schedule optimization |
| GET | `/schedule/:projectId/daily/:shootDate` | Daily breakdown |
| DELETE | `/schedule/:projectId` | Clear all schedule data |
| GET | `/day-settings/:projectId` | All day settings |
| GET | `/day-settings/:projectId/:shootDate` | Day settings for date |
| PUT | `/day-settings/:projectId/:shootDate` | Upsert day settings |
| GET | `/call-sheet/:projectId/days` | List shooting days |
| GET | `/call-sheet/:projectId/:shootDate` | Generate call sheet |
| GET | `/call-sheet/:projectId/:shootDate/text` | Call sheet as text |

### Locations

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/locations` | List all locations |
| GET | `/locations/:locationId` | Get location details |
| GET | `/production-locations/:projectId` | Project filming locations |
| POST | `/production-locations` | Create filming location |
| PUT | `/production-locations/:locationId` | Update filming location |
| DELETE | `/production-locations/:locationId` | Delete filming location |
| GET | `/project-location/:projectId` | Get project-level location settings |
| PUT | `/project-location/:projectId` | Update project location settings |

---

## Access Control

Access is checked via `checkProjectAccessForUser()` which returns `{ hasAccess, isOwner, role, canEdit }`.

- **Owner, Admin, Editor** (`canEdit: true`) -- full read/write access
- **Viewer** (`canEdit: false`) -- read-only; write endpoints return 403

All write endpoints verify `canEdit` before proceeding. Read endpoints only check `hasAccess`.

---

## Common Gotchas

1. **Budget values are stored in cents.** A `rate_per_day` of `250000` means $2,500/day. Frontend must convert for display.

2. **Cast day assignments use delete-then-insert.** `POST /cast/:castId/days` deletes all existing assignments first, then inserts the new set. Sending an empty `dates: []` clears all assignments.

3. **Scene identity is content-based, not number-based.** If a scene is renumbered in the script, the sync service matches it by SHA256 content hash and updates the scene_number rather than creating a duplicate.

4. **Export routes are mounted first in the router.** This prevents `/call-sheet/:projectId/:shootDate/export/csv` from being caught by `/call-sheet/:projectId/:shootDate`.

5. **Crew season_id filtering defaults to NULL.** When no `season_id` query param is provided, the crew endpoint returns only crew with `season_id IS NULL` (project-level crew). Pass `season_id` explicitly to get season-scoped crew.

6. **Call sheet cast auto-linking matches by character name.** The `character_name` on `production_cast` must match the character names extracted from the script. Case-insensitive matching is used, but spelling must match.

7. **Prerequisites middleware blocks all production writes until first sync.** The first time a user opens production planning, the frontend must trigger `POST /sync/:projectId` to initialize production_scene_data.

8. **`production_scene_data` vs `scene_cards` are separate tables.** `production_scene_data` tracks scheduling/sync state. `scene_cards` store AI-analyzed metadata (props, vehicles, effects). Both are keyed by project_id + scene_number but serve different purposes.

---

## Production Assets & Scene Breakdown

Two-level system: project-level assets and per-scene asset links.

### Production Assets (project-level registry)

**Table:** `production_assets` -- project-wide catalog of props, wardrobe, vehicles, VFX, etc.

**Endpoints** (in `routes/production/scenes.ts`):
- `GET /assets/:projectId` -- all assets for a project (`?department=` filter)
- `POST /assets` -- create asset (requires `project_id`, `name`, `department`)
- `PUT /assets/:id` -- update asset fields
- `DELETE /assets/:id` -- delete asset

### Scene Breakdown Items (asset-scene links)

**Table:** `scene_breakdown_items` -- links `production_assets` to `production_scene_data` (unique on `scene_data_id, asset_id`).

**Endpoints** (in `routes/production/scenes.ts`):
- `GET /breakdown-items/:sceneDataId` -- assets linked to a scene (with full asset details via join)
- `POST /breakdown-items` -- link asset to scene (upsert on `scene_data_id + asset_id`)
- `DELETE /breakdown-items/:id` -- unlink asset from scene

**Frontend:** `BreakdownItemsPanel` SidePanel opens from BreakdownView per scene, with department tabs.

---

## Per-Episode Cast/Crew Assignments

Links cast/crew members to specific episodes (for series projects).

**Tables:** `episode_cast` (cast_member_id + episode_id), `episode_crew` (crew_member_id + episode_id)

**Cast endpoints** (in `routes/production/cast.ts`):
- `GET /episode/:episodeId` -- cast assigned to episode
- `POST /episode-assign` -- assign cast to episode (`cast_member_id`, `episode_id`)
- `DELETE /episode-unassign` -- remove cast from episode (`cast_member_id`, `episode_id`)

**Crew endpoints** (in `routes/production/crew.ts`):
- `GET /episode/:episodeId` -- crew assigned to episode
- `POST /episode-assign` -- assign crew to episode (`crew_member_id`, `episode_id`)
- `DELETE /episode-unassign` -- remove crew from episode (`crew_member_id`, `episode_id`)

**Frontend:** CastCrewView shows an "Episode" checkbox column when an episode is selected.
