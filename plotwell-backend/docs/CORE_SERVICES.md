# plotwell Core Content Services

**Last Updated**: April 5, 2026

---

## Overview

Core CRUD services for all project content: projects, characters, locations, storyboards, documents, conversations, TV series (seasons/episodes), beats, comments, Script Doctor, user management, storage, and email. All protected routes require JWT authentication via `requireAuth` middleware.

---

## Architecture

### Key Files

| Domain | Route File | Service File | Controller |
|--------|-----------|-------------|------------|
| **Projects** | `routes/projects.ts` | - | - |
| **Characters** | `routes/characters.ts` | `services/charactersService.ts` | `controllers/charactersController.ts` |
| **Character Images** | `routes/characterImages.ts` | `services/characterImagesService.ts` | - |
| **Character Elements** | `routes/characterElements.ts` | `services/characterElementsService.ts` | - |
| **Locations** | `routes/locations.ts` | `services/locationImageService.ts` | - |
| **Location Images** | `routes/locationImages.ts` | `services/locationImagesService.ts` | - |
| **Storyboards** | `routes/storyboard.ts` | - | - |
| **Documents** | `routes/documents.ts` | - | - |
| **Conversations** | `routes/conversations.ts` | - | - |
| **Seasons** | `routes/seasons.ts` | - | - |
| **Episodes** | `routes/episodes.ts` | - | - |
| **Beats** | `routes/beats.ts` | `services/beatExportService.ts` | - |
| **User** | `routes/user.ts` | - | - |
| **Comments** | `routes/comments.ts` | - | - |
| **Script Doctor** | `routes/scriptDoctorV2.ts` | `services/scriptDoctorService.ts` | - |
| **Collaboration** | `routes/collaboration.ts` | `services/collaborationServer.ts` | - |
| **Structure Templates** | `routes/structureTemplates.ts` | - | - |
| **Public Share** | `routes/publicShare.ts` | - | - |
| **Import** | `routes/import.ts` | - | - |
| **Usage** | `routes/usage.ts` | - | - |
| **Storage** | - | `services/storageService.ts` | - |
| **Email** | - | `services/emailService.ts` | - |
| **Operation Locks** | - | `services/operationLockService.ts` | - |

### Database Tables

| Table | Purpose |
|-------|---------|
| `projects` | Project metadata, settings, cover page fields |
| `characters` | Character profiles per project |
| `character_images` | Character images (max 3 per character) |
| `character_elements` | Costume/prop/accessory items (max 3 per character) |
| `locations` | Story locations per project |
| `location_images` | Location images (max 3 per location) |
| `storyboard_panels` | Storyboard panels linked to scenes |
| `project_documents` | Treatment, logline, synopsis, etc. |
| `project_document_versions` | Version history for documents |
| `conversations` | AI brainstorming chat sessions |
| `conversation_messages` | Individual messages in conversations |
| `seasons` | TV series seasons |
| `episodes` | TV series episodes (linked to seasons) |
| `beats` | Story structure beats |
| `scripts` | Script content (TipTap JSON) |
| `project_collaborators` | Collaboration access records |
| `structure_templates` | Story structure templates (built-in + user-custom) |
| `public_project_shares` | Shareable read-only links with crypto tokens |
| `operation_locks` | Database-backed idempotency locks with TTL |
| `comments` | Threaded comments on project content |
| `comment_reactions` | Emoji reactions on comments |
| `script_doctor_analyses` | Cached scene-level Script Doctor analyses |
| `script_doctor_settings` | Per-project Script Doctor settings |
| `script_doctor_dismissed_issues` | Dismissed/acknowledged Script Doctor issues |
| `episode_characters` | Character-episode mapping for TV series |
| `episode_locations` | Location-episode mapping for TV series |

### Data Model Relationships

```
Project (film/series/short)
  ├── Characters → Character Images (max 3) + Character Elements (max 3)
  ├── Locations → Location Images (max 3)
  ├── Scripts → Script Doctor Analyses + Dismissed Issues
  ├── Storyboard Panels (linked via scene_id hash)
  ├── Documents → Document Versions
  ├── Conversations → Messages
  ├── Comments → Reactions
  ├── Beats
  ├── Public Shares (optional, token-based)
  ├── Structure Templates (built-in + custom)
  └── [Series only] Seasons → Episodes → Scripts
      ├── Episode Characters (cross-episode mapping)
      └── Episode Locations (cross-episode mapping)
```

---

## Projects

### Key Rules

- **`projects.name`** = project identifier (e.g., "My Film Project"). **Always use `name`, not `title`.**
- **`projects.title`** = screenplay title for cover page (e.g., "THE DARK KNIGHT")
- `project_type`: `'film'` | `'series'` | `'short'`
- **Soft delete**: `DELETE /:id` sets `deleted = TRUE`. `DELETE /:id/permanent` hard-deletes.
- **Archive/Unarchive**: `PATCH /:id/status` with `{ status: 'archived' }`. Archived projects are read-only (enforced by `checkProjectArchived` middleware).
- Series projects require Pro plan.

### API Endpoints (`/api/projects`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | List all projects (owned + collaborator). `?trashed=true` for trash |
| POST | `/` | Create project (checks project limit) |
| GET | `/:id` | Get single project |
| PUT | `/:id` | Update project |
| PATCH | `/:id/status` | Change status (archive/unarchive) |
| DELETE | `/:id` | Soft delete (set `deleted = true`) |
| DELETE | `/:id/permanent` | Hard delete from trash |
| POST | `/:id/restore` | Restore from trash |
| POST | `/:id/onboarding-complete` | Mark project onboarding as complete |
| POST | `/:id/unarchive` | Unarchive project |
| POST | `/:id/unarchive-check` | Check if unarchive is possible |
| POST | `/:id/purchase-and-unarchive` | Purchase addon slot and unarchive in one step |
| GET | `/:id/cover-page` | Get cover page fields |
| PUT | `/:id/cover-page` | Update cover page fields |
| GET | `/:id/owner-subscription` | Get project owner's subscription (for collaborators) |

---

## Characters

- CRUD via controller pattern (`charactersController.ts` -> `charactersService.ts`)
- `importance_level`: 1-5 integer
- `character_type`: `'main'` | `'minor'` | `'ensemble'` | `'background'`
- **AI Fill**: Available via `POST /api/ai/characters/fill-with-ai` (see AI_SERVICE.md)
- Access checks via `checkProjectAccess` / `checkProjectAccessByRecordId`

### Character Images (`/api/characters/:characterId/images`)

- **Max 3 images** per character (enforced by service)
- First uploaded image auto-set as primary
- `image_type`: `'portrait'` | `'full_body'` | `'action'` | `'costume'` | `'reference'`
- `is_ai_generated` flag and `generation_metadata` (JSON) for AI-generated images
- Signed URLs resolved on read via `resolveImageUrls`

### Character Elements (`/api/characters/:characterId/elements`)

- **Max 3 elements** per character
- `element_type`: `'costume'` | `'prop'` | `'accessory'` | `'makeup'` | `'hairstyle'` | `'other'`
- `is_active` toggle for scene-specific visibility
- Reference image upload stored in `character-images` bucket

### API Endpoints (`/api/characters`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/?project_id=` | List characters with image/element counts |
| POST | `/` | Create character |
| PUT | `/:id` | Update character |
| DELETE | `/:id` | Delete character + cleanup images |
| POST | `/:id/upload-image` | Upload character image |

---

## Locations

- `location_type`: `'interior'` | `'exterior'` | `'both'` | `'studio'` | `'virtual'`
- `story_importance`: `'critical'` | `'major'` | `'supporting'` | `'minor'`
- **Location names stored UPPERCASE** (to match scene heading format)
- Default sort: by `story_importance` (critical first), then alphabetically
- **AI Fill**: Available via `POST /api/ai/locations/fill-with-ai` (see AI_SERVICE.md)
- Locations are **hard deleted** (not soft delete)
- GET endpoint joins `production_locations` data when available

### API Endpoints (`/api/locations`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/?project_id=` | List locations (sorted by importance, with production_location join) |
| POST | `/` | Create location |
| PUT | `/:id` | Update location |
| DELETE | `/:id` | Delete location |
| POST | `/:id/upload-image` | Upload location image |

### Location Images (`/api/locations/:locationId/images`)

- **Max 3 images** per location (enforced by service, same pattern as character images)
- First uploaded image auto-set as primary
- `image_type`: `'exterior'` | `'interior'` | `'aerial'` | `'detail'` | `'reference'`
- `is_ai_generated` flag and `generation_metadata` (JSON) for AI-generated images
- Signed URLs resolved on read via `resolveImageUrls`
- Reorder support with two-phase update (same pattern as storyboard panels)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/locations/:locationId/images` | List location images |
| GET | `/api/locations/:locationId/images/primary` | Get primary image |
| GET | `/api/locations/:locationId/images/count` | Get image count (`{ count, max: 3 }`) |
| POST | `/api/locations/:locationId/images` | Upload location image |
| PUT | `/api/locations/:locationId/images/:imageId` | Update image metadata |
| PUT | `/api/locations/:locationId/images/:imageId/set-primary` | Set as primary image |
| POST | `/api/locations/:locationId/images/reorder` | Reorder images |
| DELETE | `/api/locations/:locationId/images/:imageId` | Delete image |

---

## Storyboards

- Panels linked to scenes via `scene_id` (hash generated by `sceneIdentityService`)
- `panel_number` auto-calculated per scene if not provided
- Requires Pro plan (`requireFeature('storyboards')`)
- **Reorder**: Two-phase update (set temp high numbers 1000+, then final numbers) to avoid unique constraint conflicts
- Image upload goes to `project-assets` bucket; AI-generated images to `storyboard-images` bucket
- `linked_character_ids` (max 3 UUIDs) and `linked_location_id` for AI image context

### API Endpoints (`/api/storyboard`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/scenes?project_id=` | Get scenes from script (for scene selector) |
| GET | `/?project_id=&scene_id=` | Get panels (filterable by scene/episode) |
| GET | `/:project_id` | Get panels by project ID (direct access, filterable by episode/scene) |
| POST | `/` | Create panel (requires scene_id, scene_number, scene_heading) |
| PUT | `/reorder` | Batch reorder panels |
| PUT | `/:id` | Update panel |
| DELETE | `/:id` | Delete panel |
| POST | `/:id/upload-image` | Upload panel image |
| POST | `/fill-with-ai` | AI-generate panels from project content |

---

## Documents

- `document_type`: `'treatment'` | `'logline'` | `'synopsis'` | `'character_breakdown'` | `'pitch_deck'` | `'custom'`
- **Free plan limit**: max 2 documents (enforced by `checkDocumentCreationLimit`)
- Content stored as TipTap JSON
- List endpoint excludes `content` field for performance
- **Version control** (Pro plan only): Smart retention policy with 4 tiers:
  - Active (0-14 days): keep all
  - Recent (14-60 days): keep first-of-day + significant changes
  - Medium (60-365 days): weekly snapshots
  - Long-term (365+ days): monthly snapshots
- Manual checkpoints never auto-deleted
- Max 500 versions per document, min 10 always kept
- Export to `.docx` format

### API Endpoints (`/api/documents`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/types` | List available document types |
| GET | `/pinned?project_id=` | Get pinned documents for a project |
| GET | `/?project_id=` | List documents (no content) |
| GET | `/:id` | Get document with full content |
| POST | `/` | Create document |
| PUT | `/:id` | Update document (auto-versioning every 5 min) |
| PATCH | `/:id/pin` | Pin/unpin a document |
| DELETE | `/:id` | Delete document |
| GET | `/:id/versions` | Get version history (paginated) |
| GET | `/:id/versions/:version` | Get specific version content |
| POST | `/:id/versions/:version/restore` | Restore version (creates backup first) |
| POST | `/:id/versions/checkpoint` | Create manual checkpoint |
| GET | `/:id/export/docx` | Export to Word format |
| POST | `/:id/mood-board-image` | Upload mood board image for document |
| POST | `/:id/resolve-urls` | Resolve storage paths to signed URLs in content |

---

## Conversations

- AI brainstorming chat history per project
- Messages have `role` (`'user'` | `'assistant'`), `content`, `attachments`, `token_count`, `model_used`
- `DELETE` archives the conversation (`is_archived = true`), does not hard delete
- Auto-title generation from first user message (first 6 words)
- Access control: owner + active collaborators (viewers blocked on write)

### API Endpoints (`/api/conversations`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/?project_id=` | List conversations (excludes archived) |
| GET | `/:id` | Get conversation with all messages |
| POST | `/` | Create conversation |
| PATCH | `/:id` | Update title |
| DELETE | `/:id` | Archive conversation |
| POST | `/:id/messages` | Add message |
| POST | `/:id/generate-title` | Auto-generate title from first message |

---

## TV Series (Seasons + Episodes)

- Only available for `project_type = 'series'`
- `season_number` unique per project (DB constraint: `seasons_project_id_season_number_key`)
- `episode_number` unique per season
- `episode.project_id` auto-set by DB trigger from `season.project_id`
- Season delete blocked if it has episodes (must delete episodes first)
- Episode delete permission: owner or admin only

### API Endpoints (`/api/series`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/projects/:projectId/seasons` | List seasons |
| GET | `/seasons/:seasonId` | Get single season |
| POST | `/projects/:projectId/seasons` | Create season |
| PUT | `/seasons/:seasonId` | Update season |
| DELETE | `/seasons/:seasonId` | Delete season (must be empty) |
| GET | `/seasons/:seasonId/dashboard` | Season dashboard (episodes, character matrix, budget rollup) |
| GET | `/seasons/:seasonId/budget-summary` | Per-episode and per-category budget totals |
| GET | `/seasons/:seasonId/episodes` | List episodes in season |
| GET | `/projects/:projectId/episodes` | List all episodes across seasons |
| GET | `/episodes/:episodeId` | Get single episode |
| POST | `/seasons/:seasonId/episodes` | Create episode |
| PUT | `/episodes/:episodeId` | Update episode |
| DELETE | `/episodes/:episodeId` | Delete episode |

---

## Beats

- Story structure planning cards, supports both film and TV series (episode-level)
- `beat_type`: `'setup'` | `'inciting_incident'` | `'midpoint'` | `'climax'` | `'resolution'` | `'custom'` | etc.
- `act`: `'act1'` | `'act2'` | `'act3'` etc.
- `order` field for drag-drop reorder (auto-calculated if not provided)
- Export: CSV, DOCX, HTML with options for notes, page estimates, and group-by-act
- `conversion_status`: tracks whether beat has been converted to script scene

### API Endpoints (`/api/beats` + `/api/projects/:projectId/beats`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/projects/:projectId/beats` | List all beats for project |
| GET | `/projects/:projectId/episodes/:episodeId/beats` | List beats for episode |
| POST | `/projects/:projectId/beats` | Create beat |
| PATCH | `/beats/:beatId` | Update beat |
| DELETE | `/beats/:beatId` | Delete beat |
| POST | `/beats/reorder` | Batch reorder beats |
| GET | `/projects/:projectId/beats/export/:format` | Export (csv/docx/html) |

---

## Structure Templates

**File**: `routes/structureTemplates.ts`

Story structure templates (Hero's Journey, Save the Cat, Story Circle, Sequence Approach, Kishotenketsu, etc.) supporting both built-in defaults and user-created custom templates.

- Stored in `structure_templates` table with `is_default` flag for built-in templates
- Filterable by `category`: `'film'`, `'tv'`, `'both'`
- Sorted by `is_default` (built-in first), then by `usage_count` (most popular first)
- Custom templates are scoped to the creating user via `created_by`

### API Endpoints (`/api/structure-templates`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/structure-templates` | List all templates (built-in + user's custom, filterable by category) |
| GET | `/structure-templates/:templateId` | Get single template |
| POST | `/structure-templates` | Create custom template |
| PATCH | `/structure-templates/:templateId` | Update custom template (owner only) |
| DELETE | `/structure-templates/:templateId` | Delete custom template (owner only) |
| POST | `/projects/:projectId/apply-template` | Apply a template to a project (creates beats from template) |

---

## Public Share

**File**: `routes/publicShare.ts`

Shareable read-only links to projects. Public GET endpoint requires no authentication (token-based access). Management endpoints require authentication + project ownership.

- Share tokens are 32 bytes, cryptographically random (via `crypto.randomBytes`)
- Optional password protection (SHA-256 hashed, stored in DB)
- Owner selects which sections to share (script, characters, locations, storyboard, etc.)
- Rate limited: 30 requests/min for public endpoint (IP-based), 30/min for management (user-based)

### API Endpoints (`/api/share`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/:token` | No | View shared project data (sections owner chose to share) |
| POST | `/` | Yes | Create share link for a project |
| GET | `/project/:projectId` | Yes | List all share links for a project (owner only) |
| PATCH | `/:shareId` | Yes | Update share link (toggle active, change sections, set expiry) |
| DELETE | `/:shareId` | Yes | Permanently delete a share link (owner only) |

---

## Import

**File**: `routes/import.ts`

Backend endpoint for importing scripts from FDX/Fountain formats. Content is parsed on the frontend; the backend receives TipTap JSON plus metadata.

- `POST /api/scripts/import` -- creates script, optionally imports characters/locations
- Validates `file_type` (`'fdx'` or `'fountain'`), content structure
- Accepts `options.import_characters` and `options.import_locations` to auto-create entities
- Supports `target_script_id` to overwrite an existing script instead of creating a new one
- Uses 50mb payload limit (set in `server.ts`)

---

## Operation Lock Service

**File**: `services/operationLockService.ts`

Database-backed operation locks using the `operation_locks` table. Replaces in-memory Maps for idempotency, cooldowns, and deduplication across multiple server instances.

- `acquireLock(lockType, lockKey, ttlSeconds)` -- insert-based lock (unique constraint prevents duplicates)
- `releaseLock(lockType, lockKey)` -- explicit release before TTL expires
- `isLocked(lockType, lockKey)` -- check without acquiring
- `acquireLockWithResult(lockType, lockKey, ttlSeconds)` -- acquire and store a result payload
- `getLockResult(lockType, lockKey)` -- retrieve stored result
- `cleanupExpiredLocks()` -- remove expired rows (runs every 5 minutes via server.ts interval)

**Fail-open design**: On unexpected database errors, the lock is not acquired but the operation proceeds (availability over strict consistency).

Used by: billing operations, request deduplication middleware, AI generation dedup.

---

## Storage Service

**File**: `services/storageService.ts`

All Supabase storage buckets are **PRIVATE** (configured in Supabase Dashboard). The DB stores file **paths** (e.g., `characters/abc/image.png`), never full URLs. Signed URLs are generated on read with 1-hour expiry.

### Buckets

| Bucket | Content |
|--------|---------|
| `character-images` | Character portraits + element reference images |
| `location-images` | Location images |
| `storyboard-images` | AI-generated storyboard images |
| `project-assets` | User-uploaded storyboard images, general assets |
| `presentation-images` | Pitch deck images |

### Key Functions

- `getSignedUrl(bucket, path)` - Single file signed URL (1h expiry)
- `getSignedUrls(bucket, paths)` - Batch signed URLs (more efficient)
- `resolveImageUrls(records, mappings)` - Transform DB records' image fields to signed URLs
- `resolveNestedImageUrls(records, field, mappings)` - For nested arrays (e.g., character_images)
- `uploadAndGetPath(bucket, path, buffer)` - Upload, returns path (not URL)
- `deleteFile(bucket, path)` - Delete from storage
- `extractStoragePath(value, bucket)` - Extract plain path from URL or return as-is
- `detectBucket(value)` - Detect which bucket a URL belongs to

---

## User Management

**File**: `routes/user.ts`

### API Endpoints (`/api/user`)

| Method | Path | Purpose |
|--------|------|---------|
| **Profile** | | |
| GET | `/profile` | Get user profile |
| PUT | `/profile` | Update profile (full_name, ui_language) |
| GET | `/ui-language` | Get user's UI language preference |
| PUT | `/ui-language` | Update UI language preference |
| PUT | `/marketing-consent` | Update marketing email consent (GDPR) |
| **Subscription** | | |
| GET | `/subscription` | Get subscription status (polled every 30s by frontend, syncs with Stripe) |
| GET | `/subscription/addons` | Get available addon pricing for user's current plan |
| POST | `/subscription/addons/checkout` | Create Stripe checkout session for addon purchase |
| POST | `/subscription/addons/purchase` | **Deprecated** -- returns 501, use unified billing |
| GET | `/subscription/addons/transactions` | Get addon transaction history |
| POST | `/subscription/addons/reduce` | Reduce addon quantity |
| GET | `/subscription/limits` | Get effective subscription limits (including addons) |
| GET | `/subscription/:userId` | Get subscription for a specific user (admin) |
| POST | `/subscription/sync` | Force sync subscription with Stripe |
| POST | `/subscription/init` | Initialize subscription record for a user |
| **Billing** | | |
| GET | `/billing/overview` | Billing overview |
| GET | `/billing/monthly-summary` | Monthly billing summary |
| GET | `/billing/can-create-project` | Check if user can create a new project |
| GET | `/billing/cycle-info` | Billing cycle info |
| POST | `/billing/process-monthly` | Process monthly billing |
| **Onboarding & Tours** | | |
| GET | `/projects-tour` | Get projects tour completion status |
| POST | `/projects-tour/complete` | Mark projects tour as complete |
| **Account Management** | | |
| DELETE | `/delete-account` | Delete user account and all data |
| GET | `/data-export` | Export all user data (GDPR) |
| POST | `/invalidate-sessions` | Invalidate all active sessions |

---

## Email Service

**File**: `services/emailService.ts`

SMTP via nodemailer. Currently only used for collaboration invitation emails.

- `sendCollaboratorInvitation(data)` - Sends HTML email with invite link, personal message, expiration date
- HTML templates in `email-templates/collaborator-invitation.html`
- Template variables replaced with `{{variable}}` syntax, HTML-escaped by default
- Environment variables: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL`

---

## Comments

**File**: `routes/comments.ts`

Threaded comments on any project content type (script scenes, storyboard panels, documents, etc.). Supports reactions and read tracking.

- Content addressed by `contentType` + `contentId` (e.g., `script/scene-123`)
- Threaded replies via `parent_id`
- Reactions (emoji) per comment
- Read tracking per user per comment
- Access control via `requireCommentsAccess` middleware (checks project membership)

### API Endpoints (`/api/comments`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/:contentType/:contentId` | Get comments for content |
| GET | `/:contentType/:contentId/stats` | Get comment stats (counts) |
| POST | `/` | Create comment |
| PUT | `/:commentId` | Update comment (author only) |
| DELETE | `/:commentId` | Delete comment (author or admin) |
| POST | `/:commentId/reactions` | Add/toggle reaction on comment |
| POST | `/:commentId/read` | Mark comment as read |

---

## Script Doctor

**File**: `routes/scriptDoctorV2.ts`, `services/scriptDoctorService.ts`, `services/scriptDoctorPrompts.ts`

Scene-level screenplay analysis with AI. Supports batch analysis, SSE streaming progress, cached results, settings, and issue dismissal. Requires Pro plan for full access.

### API Endpoints (`/api/script-doctor/v2`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/analyze-batch` | Analyze multiple scenes (AI, full middleware chain) |
| POST | `/analyze-batch-stream` | Analyze with SSE progress streaming |
| GET | `/scenes/:projectId/:scriptId` | Get all cached analyses for a script |
| DELETE | `/scenes/:projectId/:scriptId` | Clear all cached analyses |
| GET | `/settings/:projectId` | Get Script Doctor settings |
| PUT | `/settings/:projectId` | Update Script Doctor settings |
| GET | `/dismissed/:projectId/:scriptId` | Get dismissed issue IDs |
| POST | `/dismiss-issue` | Dismiss or acknowledge an issue |
| DELETE | `/dismiss-issue` | Undismiss an issue (restore) |

---

## Usage Tracking

**File**: `routes/usage.ts`

AI usage metrics and history for the current user.

### API Endpoints (`/api/usage`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/current` | Get current billing period usage |
| GET | `/history` | Get usage history across periods |
| GET | `/breakdown` | Get usage breakdown by category |
| GET | `/all-time` | Get all-time usage totals |
| GET | `/events` | Get raw usage events |

---

## Access Control Patterns

### Roles

| Role | Read | Write | Delete | Manage Collaborators |
|------|------|-------|--------|---------------------|
| **owner** | Yes | Yes | Yes | Yes |
| **admin** | Yes | Yes | Yes | Yes |
| **editor** | Yes | Yes | No (some domains) | No |
| **viewer** | Yes | No | No | No |

### Middleware Chain

- `requireAuth` - JWT validation
- `extractUserId` - Extract user ID from token
- `checkProjectAccess` / `checkProjectAccessByRecordId` - Verify owner or active collaborator
- `checkProjectArchived` / `checkProjectArchivedByRecordId` - Block writes on archived projects
- `requireFeature('storyboards')` - Pro plan feature gate
- `checkDocumentCreationLimit` - Free plan document limit
- `checkProjectLimit` - Free plan project limit

---

## Common Gotchas

1. **`projects.name` vs `projects.title`.** `name` is the project identifier. `title` is the screenplay title for the cover page. Querying the wrong field is a common bug.

2. **Locations are hard deleted, projects are soft deleted.** Characters, storyboard panels, documents, beats, and episodes are also hard deleted. Only projects use soft delete (`deleted = true`).

3. **Location names are stored UPPERCASE.** The backend forces `name.toUpperCase()` on create and update to match scene heading format (e.g., "INT. COFFEE SHOP").

4. **Storyboard reorder uses two-phase update.** First sets all panel_numbers to temporary values (1000+), then updates to final values. This avoids unique constraint violations when swapping positions.

5. **Document list endpoint excludes content.** `GET /api/documents/` only returns metadata. Use `GET /api/documents/:id` to fetch full content. This is a performance optimization since document content (TipTap JSON) can be very large.

6. **Character images max 3, elements max 3, location images max 3.** These limits are enforced in the service layer, not the route. The count endpoint returns `{ count, max: 3 }`.

7. **Season delete requires empty season.** You must delete all episodes in a season before deleting the season itself.

8. **Conversation delete is actually archive.** `DELETE /conversations/:id` sets `is_archived = true`, it does not remove the record.

9. **Signed URLs expire in 1 hour.** The frontend must handle expired URLs gracefully. Storage paths in the DB are stable; only the signed URLs are temporary.

10. **AI Fill endpoints require full middleware chain.** `fill-with-ai` on characters, locations, and storyboards goes through: `requireAuth -> extractUserId -> addPricingService -> checkAIGenerationLimit -> trackAIUsage`.

---

## Character/Location Scope Filtering

For TV series, characters and locations have a `scope` field: `project`, `series`, `season`, `episode`.

**Character filtering** (`GET /api/characters?project_id=X`):
- `?scope=project` -- series-wide characters only
- `?scope=season&season_id=Y` -- characters for a specific season
- `?scope=episode&episode_id=Z` -- guest characters for a specific episode
- No scope param returns all characters

**Location filtering** (`GET /api/locations?project_id=X`):
- Same pattern as characters

**Cross-episode mapping** (`routes/episodes.ts`):
- `GET /characters/:characterId/episodes` -- which episodes a character appears in
- `GET /projects/:projectId/episode-characters` -- full character-episode matrix
- `GET /locations/:locationId/episodes` -- which episodes a location appears in
- `GET /projects/:projectId/episode-locations` -- full location-episode matrix

**Frontend hook:** `useEpisodeMapping(projectId)` returns `characterMatrix` and `locationMatrix`.

---

## Marketing Consent

GDPR-compliant marketing email consent.

**Columns on `public.users`:** `marketing_consent` (BOOLEAN), `marketing_consent_at` (TIMESTAMPTZ)

**Collection points:**
- Signup page checkbox (passed via Supabase auth metadata -> `handle_new_user` trigger)
- Settings page toggle (`PUT /api/user/marketing-consent`)

**Endpoint:** `PUT /api/user/marketing-consent` -- body: `{ consent: boolean }` (also listed in User Management above)
