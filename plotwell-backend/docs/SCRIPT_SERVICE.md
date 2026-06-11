# plotwell Script Service

**Last Updated**: April 5, 2026

---

## Overview

Scripts are stored as ProseMirror JSON documents (legacy TipTap format auto-converted). The script service handles CRUD, scene parsing and caching, import/export to industry formats, timing estimation, AI scene insertion, version control, and Script Doctor analysis. TV series scripts are linked via `episode_id`.

---

## Architecture

| Layer | File | Purpose |
|-------|------|---------|
| **Routes** | `routes/scripts.ts` | Script CRUD, export, timing, version control |
| **Routes** | `routes/scriptDoctorV2.ts` | Script Doctor analysis endpoints |
| **Routes** | `routes/import.ts` | FDX/Fountain import |
| **Parsing** | `services/scriptParsingService.ts` | ProseMirror JSON to scene data, scene cache |
| **Identity** | `services/sceneIdentityService.ts` | SHA-256 scene IDs, fuzzy matching, storyboard sync |
| **Export** | `services/scriptExportService.ts` | FDX, Fountain, DOCX export |
| **Timing** | `services/scriptTimingService.ts` | Page/minute estimation |
| **Insertion** | `services/sceneInsertionService.ts` | AI scene insertion into scripts |
| **Doctor** | `services/scriptDoctorService.ts` | AI scene-level analysis with caching |
| **Prompts** | `services/scriptDoctorPrompts.ts` | Script Doctor system prompts |
| **Scene Extractor** | `utils/sceneExtractor.ts` | Extract scenes by number/range from ProseMirror JSON |
| **Beat Export** | `services/beatExportService.ts` | Beat sheet export to CSV, DOCX, HTML |
| **Beats** | `routes/beats.ts` | Beat CRUD, reorder, export endpoints |

### Database Tables

| Table | Purpose |
|-------|---------|
| `scripts` | Script content (ProseMirror JSON), scene cache, episode link |
| `script_versions` | Version history (content snapshots, change summaries) |
| `ai_generated_scenes` | AI scenes pending insertion into scripts |
| `script_doctor_scene_analyses` | Cached analysis results, keyed by content_hash + settings_hash |
| `script_doctor_settings` | Per-project analysis configuration |

---

## ProseMirror Content Format

Scripts are stored as ProseMirror JSON in `scripts.content`. Each node has a `type` field identifying its screenplay element type. Legacy TipTap format (`paragraph` + `class` attribute) is auto-converted via `ensureProsemirrorFormat()`:

| Node Type | Element | Example |
|-----------|---------|---------|
| `sceneHeading` | Scene heading | `INT. COFFEE SHOP - DAY` |
| `action` | Action/description | `Sarah enters the room.` |
| `character` | Character cue | `SARAH` |
| `dialogue` | Dialogue line | `I didn't expect to see you here.` |
| `parenthetical` | Parenthetical | `(whispering)` |
| `transition` | Transition | `CUT TO:` |

```json
{
  "type": "doc",
  "content": [
    {
      "type": "sceneHeading",
      "content": [{ "type": "text", "text": "INT. COFFEE SHOP - DAY" }]
    }
  ]
}
```

---

## Script CRUD

### Create

`POST /api/scripts` with `{ project_id, content, title?, episode_id?, is_ai_generated? }`.

**Auto-promote first script**: The first script created for a project (or episode in TV series) is automatically promoted to production:
- Movies: sets `projects.prod_script_id`
- TV series: sets `episodes.script_id`

### Read

- `GET /api/scripts?project_id=X&episode_id=Y` - List scripts (use `include_content=false` for lightweight checks)
- `GET /api/scripts/:id` - Single script with full content

### Update

`PUT /api/scripts/:id` with `{ content?, title?, change_summary?, create_version? }`.

On content update:
1. Scene cache is invalidated (`scripts.scenes` set to null)
2. Storyboard panel scene_ids are synced via fuzzy matching (handles scene renames)
3. Version may be created (see Version Control section)

### Delete

`DELETE /api/scripts/:id` - Hard delete. If the script is a production script, the reference (`prod_script_id` or `episodes.script_id`) is cleared first.

### Promote

`POST /api/scripts/:id/promote` with `{ project_id, episode_id? }` - Sets the script as the production script.

---

## Scene Parsing and Caching

`ScriptParsingService.parseScriptContent(content)` walks ProseMirror nodes, splits on `sceneHeading` nodes, and returns `SceneData[]` with:
- `scene_number`, `heading`, `location`, `time_of_day`, `int_ext`
- `action_content` (concatenated text of action, dialogue, character, transition nodes)
- `characters` (deduplicated, normalized - strips ALL parenthetical extensions like `(V.O.)`, `(CONT'D)`)
- `estimated_pages` (CSS-aware line counting with margin collapsing, element-specific characters-per-line wrapping, and vertical spacing constants that match `screenplay.css`; 36 lines/page matching ProseMirror pagination)
- `dialogue_count`

**Caching**: Parsed scenes are stored in `scripts.scenes` (JSONB). The cache is **lazily invalidated** - set to null on script update, repopulated on next read via `parseScriptFromProject()`.

**Script resolution priority**: `active_script_id` > `prod_script_id` > latest by `created_at`.

---

## Scene Identity

`sceneIdentityService.ts` provides stable scene identification across script revisions.

**Scene ID**: SHA-256 hash of a fingerprint containing heading, location, time_of_day, int_ext, characters, and first 100 chars of action. Remains stable when scene numbers change.

**Content Hash**: SHA-256 of full scene content (heading + location + characters + action). Changes when any content changes.

**Storyboard Sync** (`syncStoryboardSceneIds`): When a scene heading is renamed, its content-based scene_id changes, orphaning storyboard panels. The sync function:
1. Finds orphaned panel scene_ids (exist in panels but not in current script)
2. Fuzzy-matches orphans to new scenes (80% heading similarity + 20% scene number proximity)
3. Re-links panels with confidence threshold > 0.5

This runs automatically on every script content update.

### Scene Extractor

`utils/sceneExtractor.ts` provides utility functions for extracting specific scenes from TipTap JSON without parsing the full script.

- `extractSceneByNumber(content, sceneNumber)` -- single scene by number
- `extractScenesByRange(content, start, end)` -- inclusive range
- `extractScenesByNumbers(content, numbers[])` -- specific scene numbers
- `extractAllScenes(content)` -- all scenes as `SceneContent[]`

Returns `SceneContent` with: `sceneNumber`, `heading`, `content` (full text), `characters`, `location`, `timeOfDay`, `estimatedPages`.

---

## Import

Content is parsed on the **frontend** (FDX and Fountain parsers in `plotwell-app/src/lib/parsers/`). The backend receives the already-converted TipTap JSON via the standard `POST /api/scripts` endpoint.

Supported formats: Final Draft (.fdx), Fountain (.fountain).

---

## Export

All export endpoints are on `GET /api/scripts/:id/export/:format`.

| Format | Endpoint | Content-Type |
|--------|----------|-------------|
| Final Draft | `/export/fdx` | `application/xml` |
| Fountain | `/export/fountain` | `text/plain` |
| Word | `/export/docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |

**Title page**: All formats include a title page built from project metadata (`projects.title`, `author`, `based_on`, `contact_info`, `copyright_notice`, `registration_number`). Falls back to `projects.name` if `title` is empty.

---

## Timing

`ScriptTimingService.calculateScriptTiming(content)` returns:
- `totalPages` / `totalMinutes` (1 page = 1 minute industry standard)
- `sceneBreakdown[]` with per-scene pages, minutes, word count, element counts (action, dialogue, parentheticals word counts)
- `elementBreakdown` (counts of scene headings, action, dialogue, transitions, parentheticals)
- `stats` (average/longest/shortest scene length, totalScenes)

**Page calculation**: Word-count-based per element type (action: 250 words/page, dialogue: 200, parenthetical: 15 words/page). Minimum 1/8 page per scene.

**Additional methods**:
- `calculateSectionTiming(content, startIndex, endIndex)` - Timing for a slice of nodes
- `calculateReadingTime(content)` - Reading time at 225 words/minute
- `getPageBreakdown(content)` - Page-by-page breakdown with scene ranges
- `getFormatTimingMultiplier(projectType)` - Format multipliers: Feature = 1.0, Short = 1.1, Series = 0.95

---

## Scene Insertion

`SceneInsertionService.insertScene(options)` inserts AI-generated scenes (from `ai_generated_scenes` table) into scripts.

**Insert positions**: `beginning`, `end`, `after` (scene N), `before` (scene N).

**Target scene**: For `after` and `before` positions, `targetSceneNumber` is a 1-based scene number (not a node index). The service finds the scene boundary by counting `sceneHeading` nodes.

Flow:
1. Fetch scene from `ai_generated_scenes` and script from `scripts`
2. Validate script has non-empty content (blocks insertion into empty scripts)
3. Sanitize scene content (remove empty text nodes that ProseMirror rejects)
4. Insert at specified position with separator comment
5. Save updated script, create version entry
6. Mark scene as `inserted` in `ai_generated_scenes`

---

## Version Control

**Paid plan only** (checked via `requireScriptVersionControl` middleware using `pricingService.hasPaidPlan()`). Collaborators use project owner's plan.

### Version Creation Logic

| Trigger | Creates Version? |
|---------|-----------------|
| `create_version=true` in request | Always |
| Custom `change_summary` (not "Auto-save") | Always |
| Auto-save | Only if 5+ minutes since last version |

### Restore

`POST /api/scripts/:id/versions/:version/restore` - Creates a backup of current state first, then overwrites with version content, then creates a restore version entry. Scene cache is invalidated.

### Intelligent Retention

Tiered cleanup runs after each version creation:
- **0-14 days**: Keep all versions
- **15-60 days**: Keep daily snapshots + significant changes (5%+ content change) + 4-hour session boundaries
- **61 days - 1 year**: Keep weekly snapshots + highly significant changes
- **1+ years**: Keep monthly snapshots only

Manual checkpoints and tagged versions are never deleted. Hard limit: 500 versions per script, minimum 10 kept.

---

## Script Doctor

AI-powered scene-level analysis using Grok 4.1 Fast Reasoning (2M context window).

### How It Works

1. Frontend sends all scenes to `POST /api/script-doctor/v2/analyze-batch`
2. Service checks cache by `content_hash + settings_hash` (SHA-256)
3. Uncached scenes are analyzed in a **single AI call** (full script as one block)
4. Results are cached in `script_doctor_scene_analyses` with composite key

### Analysis Output

Per scene:
- **Health score**: 0-100
- **Issues**: category, severity, message, suggestion, excerpt
- **Issue categories**: `pacing`, `dialogue`, `clarity`, `engagement`, `character`

Per script:
- **Summary**: overall assessment, strengths, focus areas

### Settings (per project)

| Setting | Options | Default |
|---------|---------|---------|
| `writing_mode` | standard, strict, minimal | standard |
| `genre` | drama, comedy, thriller, etc. | drama |
| `enabled_categories` | any subset of 5 categories | all 5 |
| `analysis_mode` | on-save, on-demand, periodic | on-demand |
| `custom_notes` | free text | empty |

### Cache Invalidation

Cache is keyed by `content_hash + settings_hash`. Changing either the scene content or analysis settings produces a new hash, causing a cache miss and fresh analysis. `forceRefresh=true` clears all cached analyses for the script.

---

## TV Series Support

Scripts link to episodes via `scripts.episode_id`. Production script for an episode is stored in `episodes.script_id` (not `projects.prod_script_id`).

- `GET /api/scripts?project_id=X&episode_id=Y` filters by episode
- `POST /api/scripts` with `episode_id` links to episode
- `POST /api/scripts/:id/promote` with `episode_id` updates `episodes.script_id`
- Scene parsing, storyboard sync, and Script Doctor all accept `episodeId`

---

## API Endpoints

### Script CRUD (`/api/scripts`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | Yes | List scripts for project (query: `project_id`, `episode_id?`, `include_content?`) |
| GET | `/:id` | Yes | Get single script |
| POST | `/` | Yes | Create script |
| PUT | `/:id` | Yes (write) | Update script content/title |
| DELETE | `/:id` | Yes (write) | Delete script |
| POST | `/:id/promote` | Yes (write) | Promote to production script |

### Export (`/api/scripts`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/:id/export/fdx` | Yes | Export Final Draft XML |
| GET | `/:id/export/fountain` | Yes | Export Fountain plain text |
| GET | `/:id/export/docx` | Yes | Export Word document |

### Timing (`/api/scripts`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/:id/timing` | Yes | Full script timing analysis |
| POST | `/:id/timing/section` | Yes | Section timing (startIndex, endIndex) |

### Version Control (`/api/scripts`, Paid plan)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/:id/versions` | Yes + Paid | Paginated version history |
| GET | `/:id/versions/:version` | Yes + Paid | Get version content |
| POST | `/:id/versions/:version/restore` | Yes + Paid | Restore version (creates backup first) |
| POST | `/:id/versions/checkpoint` | Yes + Paid | Create manual checkpoint |

### Script Doctor (`/api/script-doctor/v2`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/analyze-batch` | Yes + AI limits | Analyze scenes (batch, single AI call) |
| GET | `/scenes/:projectId/:scriptId` | Yes | Get cached analyses |
| GET | `/settings/:projectId` | Yes | Get analysis settings |
| PUT | `/settings/:projectId` | Yes | Update analysis settings |
| DELETE | `/analyses/:projectId/:scriptId` | Yes | Clear cached analyses |

---

## Beats API Endpoints (`/api/beats`)

Beats routes are mounted under `/api/beats` in `server.ts`. All routes require `requireAuth` + `extractUserId`.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/projects/:projectId/beats` | Yes | List all beats for a project |
| GET | `/projects/:projectId/episodes/:episodeId/beats` | Yes | List beats for a specific episode (TV series) |
| POST | `/projects/:projectId/beats` | Yes (write) | Create a new beat |
| PATCH | `/beats/:beatId` | Yes (write) | Update a beat (allowed fields: title, description, notes, order, act, beat_type, color, page_estimate, duration_estimate, script_id, scene_number, conversion_status, template_id) |
| DELETE | `/beats/:beatId` | Yes (write) | Delete a beat (hard delete) |
| POST | `/beats/reorder` | Yes (write) | Batch reorder beats (drag-and-drop) |
| GET | `/projects/:projectId/beats/export/:format` | Yes | Export beats (csv, docx, html). Viewers can export. |

---

## Beat Export

`BeatExportService` exports beat sheets to multiple formats.

| Format | Method | Content |
|--------|--------|---------|
| CSV | `exportToCSV(projectId, episodeId?, options)` | Tabular beat data with optional notes, page estimates |
| DOCX | `exportToDocx(projectId, episodeId?, options)` | Formatted document with act grouping |
| HTML | `exportToHTML(projectId, episodeId?, options)` | Printable HTML with styling |

**Export options**: `includeNotes`, `includePageEstimates`, `groupByAct`.

Beat types: `setup`, `inciting_incident`, `midpoint`, `climax`, `resolution`, `rising_action`, `turning_point`, `crisis`, `custom`.

Acts: `act1`, `act2a`, `act2b`, `act3`, `act4`, `act5`, `custom`.

---

## Common Gotchas

1. **`projects.name` vs `projects.title`**: `name` is the project identifier. `title` is the screenplay title for cover pages/exports. Export service falls back to `name` if `title` is empty.

2. **Scene cache invalidation**: `scripts.scenes` is set to null on update but not repopulated until the next read. Any code reading `scripts.scenes` directly may get null and must handle it.

3. **Storyboard sync on scene rename**: Runs automatically on every `PUT /api/scripts/:id` with content changes. Uses fuzzy matching (Levenshtein distance) to re-link orphaned panels. Threshold is 0.5 confidence.

4. **Archived projects are read-only**: All write operations (create, update, delete, promote, restore, checkpoint) return 403 for archived projects.

5. **Version control requires a paid plan**: All `/versions` endpoints check the project owner's subscription via `hasPaidPlan()`, even for collaborators. Free plan users get no version history.

6. **Script Doctor cache key**: Both content and settings are hashed. Changing writing mode or enabled categories invalidates the cache even if content hasn't changed.

7. **Scripts are hard-deleted**: Unlike projects (soft delete with `deleted=true`), scripts use `DELETE FROM scripts`. Versions are also hard-deleted during cleanup.

8. **Import is frontend-only**: The backend never parses FDX or Fountain files. The frontend converts them to TipTap JSON before sending to `POST /api/scripts`.
