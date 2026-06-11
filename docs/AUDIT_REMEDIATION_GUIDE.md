# Audit Remediation Guide

Last updated: June 11, 2026 (second sweep: production-module IDORs A5/A6, collaborator schedule bug E1, dead toolbar C5)

Step-by-step guide for the remaining findings from the June 2026 full-app audit (security, dead code, cost, UI). Every item below was **individually verified against the current code** before being written here. Each one includes the evidence, the exact fix, and a verification command so you can re-confirm before touching anything.

## Already fixed (for context, do not redo)

| Fix | Where |
| --- | --- |
| IDORs in production schedule (reorder, daily breakdown PII, day-settings, call-sheets) | `requireProjectAccess` middleware on all 11 `:projectId` routes in `plotwell-backend/src/routes/production/schedule.ts` |
| Un-metered `/api/ai/thumbnail-bg` endpoint | Deleted entirely; the internal media tool calls Replicate directly via its own Vite proxy + `VITE_REPLICATE_API_TOKEN` |
| Subscription 30s polling | `SubscriptionContext.tsx` now refreshes on tab focus (60s throttle) + 5min background poll while visible |

## Verified clean (second sweep — don't re-audit without reason)

- Core CRUD routes (`characters`, `locations`, `scripts`, `documents` CRUD, `comments`, `conversations`, `storyboard`, `beats`, `episodes`, `seasons`, `structureTemplates`, `scriptDoctorV2`, `collaboration` flush/apply) all enforce access via middleware (`checkProjectAccess*`, `checkScriptAccess`, `checkConversationAccess`, router-level guards in the image/element routers) or in-handler ownership checks.
- Stripe: webhook uses `express.raw` + signature verification (`billing.ts:17`, `stripeService.ts:616`); checkout resolves price IDs server-side from `plan_id` (`unifiedBilling.ts:476`) — no client-controlled amounts.
- Frontend: no `setInterval` leaks; `window.location.href` uses are all external URLs or the documented logout exception (D3); `JSON.parse(localStorage...)` call sites are try-wrapped.
- `/api/tools/*` being free + IP-rate-limited is deliberate (micro-tools funnel), covered by A4.

## Working rule (learned the hard way)

Before deleting or "fixing" anything in this guide, re-run the verification command for that item. The thumbnail-bg endpoint looked like it needed an auth gate; verification showed nothing consumed it and the right fix was deletion. Assume every item here can have drifted since this document was written.

---

# A. Security

## A1. Share-link passwords: unsalted SHA-256

**Problem:** `public_project_shares.password_hash` is plain `sha256(password)` with no salt. Anyone with DB read access (or a future leak) can reverse common passwords via rainbow tables.

**Evidence:** `plotwell-backend/src/routes/publicShare.ts:19-21`

```ts
function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}
```

**Fix:**
1. `npm install bcryptjs` in plotwell-backend (pure JS, no native build issues on Render).
2. Replace `hashPassword` with `bcrypt.hashSync(password, 10)` on create (POST `/`), and `bcrypt.compareSync(password, share.password_hash)` on the public GET.
3. Migration of existing hashes is impossible (sha256 is one-way and unsalted). Handle both formats during transition: if the stored hash is 64 hex chars, compare with the old sha256 path; otherwise use bcrypt. Optional cleanup: on successful sha256 match, re-hash with bcrypt and update the row (transparent upgrade).
4. These are low-value view passwords, not account credentials, so cost factor 10 is enough.

**Verify first:** `grep -n "hashPassword" plotwell-backend/src/routes/publicShare.ts` — confirm both call sites (create at ~line 305, compare at ~line 89).

## A2. Share password accepted via query string

**Problem:** The public GET accepts `?password=...`. Query strings get logged by proxies, CDNs, and server logs, leaking the password.

**Evidence:** `plotwell-backend/src/routes/publicShare.ts:85`

```ts
const password = req.query.password as string || req.headers['x-share-password'] as string;
```

**Fix:** Drop the query-string path; keep only the header. This is safe today because the frontend already sends the header exclusively:

- `plotwell-app/src/pages/PublicSharePage.tsx:81` → `if (pwd) headers['x-share-password'] = pwd;`
- No other consumer in the monorepo sends `?password=`.

**Verify first:** `grep -rn "password=" plotwell-app/src --include=*.tsx | grep -i share` — must return nothing new before removing the query path.

## A3. Production AI calls bypass usage tracking

**Problem:** Four `gpt-5-mini` calls run without `trackOpenAIUsageInRoute`, violating the AGENTS.md non-negotiable ("AI routes track successful usage with trackOpenAIUsageInRoute"). That spend is invisible in usage accounting and fair-use enforcement.

**Evidence (all four call sites):**

| Service call | Used by route |
| --- | --- |
| `scheduleService.ts:170` (`optimizeSchedule`) | `POST /api/production/schedule/:projectId/optimize` |
| `productionAnalysisService.ts:118` | production analysis routes (`routes/production/analysis.ts`) |
| `productionAnalysisService.ts:383` | idem |
| `productionAnalysisService.ts:685` | idem |

**Fix (follow the existing pattern from `routes/ai/scenes.ts`):**
1. Services return the completion's `usage` object alongside their result (`completion.usage` is already available where `openai.chat.completions.create` is called).
2. Routes add `addAIUsageTracker` middleware (from `middleware/aiUsageMiddleware.ts`) to the route chain.
3. After a successful service call, the route calls `await trackOpenAIUsageInRoute(req, '<operation_type>', 'gpt-5-mini', result.usage, { metadata: {...} })`.
4. Do NOT track on failure paths — the convention is successful usage only.

**Verify first:** `grep -rn "openai.chat.completions.create" plotwell-backend/src/services/scheduleService.ts plotwell-backend/src/services/productionAnalysisService.ts` and confirm none are followed by tracking.

## A4. Rate limits are in-memory

**Problem:** Every `express-rate-limit` instance uses the default MemoryStore: counters reset on each deploy/restart and are not shared if the service ever scales past one instance. Most exposed: the unauthenticated tool previews (`tools.ts:68`, 3 per IP per 24h) which call paid AI — an abuser just needs rotating IPs or a deploy window.

**Status: accepted risk for now** (single Render instance, micro-tools funnel is deliberate). Revisit when either (a) abuse appears in Replicate/OpenAI dashboards, or (b) the backend scales to >1 instance.

**Fix when needed:** `rate-limit-redis` store backed by a managed Redis (Render Key Value or Upstash). Only the limiters guarding paid AI need durable storage (`freePreviewLimiter`, `aiLimiter`, `videoLimiter`); CRUD limiters can stay in memory.

## ◼ A5. Production module IDORs, second batch (HIGH — IN PROGRESS)

The schedule.ts fix covered only one of the five production route files. The sibling files have the same disease: handlers that trust `projectId`/`castId`/`crewId`/`sceneId` from the request and call services whose `userId` parameter is **decorative** (verified: `castService.ts` never filters by user or checks ownership in `updateCallTime`, `assignCastToScenes`, `removeCastFromScene`, `bulkCreateCastFromCharacters`; `productionSyncServiceSimple.ts` `lockScene`/`unlockScene` take no user at all; `helpers.ts:64` literally says "access control is handled by the caller" — and these callers don't).

**Unprotected endpoints (each verified by reading the handler + its service):**

**FIXED (3/24):**
| File | Endpoint | 
| --- | --- |
| `production/cast.ts:474` | ✓ POST `/cast/:projectId/bulk-from-characters` — added `checkProjectAccessForUser` |
| `production/scenes.ts:140` | ✓ POST `/scene-card` — added project access check |
| `production/scenes.ts:407` | ✓ POST `/budget-item` — added project access check |

**Remaining (21 to fix):**
| File | Endpoint | Pattern |
| --- | --- | --- |
| `production/cast.ts:230` | POST `/cast/:castId/scenes` | lookup scene → projectId → checkAccess |
| `production/cast.ts:264` | DELETE `/cast/:castId/scenes/:sceneId` | lookup scene → projectId → checkAccess |
| `production/cast.ts:322` | POST `/cast/:castId/days` | lookup cast → projectId → checkAccess |
| `production/cast.ts:505` | PUT `/cast/:castId/scenes/:sceneId/call-time` | lookup scene → projectId → checkAccess |
| `production/cast.ts:566,598` | POST/DELETE `/episode-assign`, `/episode-unassign` | lookup episode → projectId → checkAccess |
| `production/crew.ts:16` | POST `/crew` | add projectId param + checkAccess |
| `production/crew.ts:344` | POST `/crew/:crewId/days` | lookup crew → projectId → checkAccess |
| `production/crew.ts:578,610` | POST/DELETE `/episode-assign`, `/episode-unassign` | lookup episode → projectId → checkAccess |
| `production/scenes.ts:1273,1302` | POST `/scenes/:sceneId/lock`, `/unlock` | lookup scene → projectId → checkAccess |
| `production/scenes.ts:2030` | POST `/breakdown-items` | verify scene_data belongs to user's project |
| `production/scenes.ts:461` | POST `/import-from-script/:projectId` | ✓ already has `checkProjectAccessForUser` in service layer? verify |
| `production/scenes.ts:525` | POST `/import-to-storyboard/:projectId` | ✓ same |
| `production/scenes.ts:1201` | POST `/sync/:projectId` | ✓ same |
| `production/scenes.ts:1229` | POST `/resolve-changes/:projectId` | ✓ same |
| `production/analysis.ts:18` | POST `/analyze-script` | add checkProjectAccessForUser + meter with `trackOpenAIUsageInRoute` |
| `production/analysis.ts:316,570` | POST `/budget-scenarios`, `/budget-health` | add checkProjectAccessForUser + meter |
| `production/analysis.ts:111,864,973` | POST `/optimize-budget`, `/optimize-schedule`, `/suggest-locations` | add checkProjectAccessForUser + meter |

**Also (cost, extends A3):** all 7 AI endpoints in `analysis.ts` (`analyze-script`, `generate-shots`, `optimize-budget`, `budget-scenarios`, `budget-health`, `optimize-schedule`, `suggest-locations`) run LLM completions with only `requireAuth` — no `checkAIGenerationLimit`, no `trackAIUsage`. Only `/fill-with-ai` (line 1034) is properly metered. Any free-plan user can burn unlimited Grok/OpenAI tokens. Minor extra: `suggest-locations` calls `locations.map(...)` on the unvalidated body (500 on bad input) — add a Zod schema while you're there.

**Fix (reuse what already exists, three patterns):**
1. Routes with `:projectId` or `projectId` in body → call `checkProjectAccessForUser(projectId, userId)` + `canEdit` for writes, exactly like the handlers in the same files that already do it (e.g. `cast.ts:31`, POST `/cast`).
2. Routes keyed by child id (`:castId`, `:crewId`, `:sceneId`, breakdown `:id`) → look up the row's `project_id` first, then check access — the pattern already used by PUT `/cast/:castId` (line 152) and DELETE `/crew/:crewId` (line 298). For `episode-assign`/`unassign`, resolve the project via the episode (`episodes.project_id`).
3. AI endpoints in `analysis.ts` → additionally add the metering chain used by `/fill-with-ai` (line 1034): `extractUserId, addPricingService, checkAIGenerationLimit, trackAIUsage`.

Where the route checks access, also ignore client-supplied `projectId` in favor of the one resolved from the DB row (don't verify one id and write with another).

**Verify first:** `node /tmp/scan` equivalent — for each endpoint above, `grep -n "checkProjectAccessForUser" plotwell-backend/src/routes/production/<file>.ts` and confirm the handler body still lacks it. Several handlers in these same files ARE protected; don't double-add.

## ✓ A6. Document version restore/checkpoint: paid users bypass project membership (FIXED)

Added `else → 403` branch to `requireDocumentVersionControl` (matching the pattern in `scripts.ts:168-170`). Now non-owner, non-collaborator users are properly denied access to document version operations.

---

# B. Backend cost

## B1. Two wasted storage calls on every location image upload

**Problem:** `uploadLocationImage` calls `supabase.storage.listBuckets()` plus a test `.list('locations', { limit: 1 })` before every upload. Both are leftover debug probes — two extra storage API round-trips per upload that only produce console noise.

**Evidence:** `plotwell-backend/src/services/locationImageService.ts:44-64`. The file also creates its own Supabase client (line 5) instead of importing the shared one from `config/database`.

**Fix:**
1. Delete the `listBuckets()` block and the test `.list()` block; keep only the `.upload()` call and its error handling (the RLS troubleshooting hints in the error message can stay).
2. Replace the local `createClient(...)` with `import { supabase } from "../config/database"`.
3. Note: this file is NOT dead. `uploadLocationImage`/`deleteLocationImage` are used by `routes/locations.ts:6`. The similarly named `locationImagesService.ts` (plural) is a different, also-live file. Do not merge them blindly.

**Verify first:** `grep -rn "locationImageService" plotwell-backend/src --include=*.ts`

## B2. Panel video polling: N requests every 8 seconds

**Problem:** While clips render, `usePanelVideos` polls `GET /panel-video-status` **once per processing panel** every 8s, plus `GET /renders` every 6s while a reel renders. Animating a 10-panel scene = ~75 requests/minute, each doing a project-access check + DB reads + a Replicate job lookup.

**Evidence:** `plotwell-app/src/hooks/usePanelVideos.ts:260-275`; backend `plotwell-backend/src/routes/ai/videos.ts:295`.

**Critical constraint discovered during verification:** the polling is not just UI notification — the backend only advances job state (persists the finished video, consumes credits, emits the `panel-video:completed` SSE event) **inside the status-poll handler** (`videos.ts:339-436`). Removing client polling without a server-side replacement would strand jobs in `processing` forever.

**Fix in two stages:**

*Stage 1 (cheap, do now):* batch the status check. Change `panel-video-status` to accept `panel_ids` (comma-separated, cap at ~20) and return an array; the hook then makes **one** request per 8s tick instead of N. Keep the per-panel param working for backwards compat during rollout.

*Stage 2 (proper):* Replicate webhooks. Pass `webhook` + `webhook_events_filter: ["completed"]` when creating the prediction; add a public webhook route that validates the `webhook-id`/`webhook-signature` headers (Replicate signs with your signing secret), runs the same persist/credit/emit logic, then have the frontend listen via the existing `useAITaskEvents` SSE hook (`panel-video:completed` / `panel-video:failed` events are already emitted). Keep a slow client poll (60s) as fallback for missed webhooks.

**Verify first:** `grep -n "aiTaskEvents.emit" plotwell-backend/src/routes/ai/videos.ts` — confirm where state transitions happen before moving them.

---

# C. Dead code

## C1. Frontend orphan files (14 files, all verified)

Each file below has **zero references anywhere in `plotwell-app/src`** outside itself — checked by full-name grep (catches static imports, lazy imports, and string references) and by directory-barrel imports.

**Delete:**

| File | Note |
| --- | --- |
| `src/components/modals/AddonPurchasePrompt.tsx` | |
| `src/components/projects/WorkspaceChoiceModal.tsx` | |
| `src/components/script/CoverPageEditor.tsx` | |
| `src/components/series/SeasonDashboard.tsx` | |
| `src/components/team/CommentsView.tsx` | The live comments UI is `src/components/comments/` |
| `src/components/onboarding/AppMockupFrame.tsx` | |
| `src/components/moodboard/MoodBoardSection.tsx` | Barrel only re-exports the *type* `MoodBoardSection` from `./types`, not this component |
| `src/components/moodboard/SortableMoodBoardItem.tsx` | |
| `src/components/moodboard/exportMoodBoardPDF.ts` | |
| `src/hooks/useEpisodeMapping.ts` | |
| `src/components/views/script/useScriptExport.ts` | |
| `src/components/billing/index.ts` | Barrel with 0 directory imports; contents are imported directly |
| `src/components/scriptDoctor/index.ts` | idem |
| `src/components/views/index.ts` | idem |

**Do NOT delete (verified alive, easy to confuse):**
- `src/components/moodboard/MoodBoardEditor.tsx` + `MoodBoardItem.tsx` + `types.ts` + `index.ts` — used by `ConceptView.tsx:44` via the barrel.
- `src/hooks/useScriptDoctor.ts` — referenced in 7 files.
- All other `components/*/index.ts` barrels — imported as directories (`from '@/components/<dir>'`).
- Backend `scriptDoctorService.ts` — used by the V2 route.

**Procedure:** delete in one commit, then run `npm run build` and `npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -v TS6133` (the repo has pre-existing unused-variable noise; you only care about new *missing module* errors). After deleting, grep each deleted file's own imports — a module only they imported may become a new orphan (cascade).

**Verify first (per file):** `grep -rn "<BaseNameWithoutExtension>" plotwell-app/src --include=*.ts --include=*.tsx | grep -v "<its own path>"` — must be empty.

## C2. Dormant HTTP sync effect in the script editor

**Problem:** `ScriptViewNew.tsx` contains a full HTTP-polling fallback for script sync (fetches the entire script every 5s solo / 1.2s with collaborators), but it early-returns because `ENABLE_SCRIPT_YJS_COLLAB = true` is hardcoded (line 151). ~75 lines that never execute.

**Evidence:** `plotwell-app/src/components/views/ScriptViewNew.tsx:1084-1156` (the effect), `:151` (the flag).

**Fix:** delete the effect body (lines ~1084-1156). **Keep** `lastRemoteUpdatedAtRef` and `isApplyingRemoteContentRef` — they are also used outside the dormant block (lines 466, 548, 840). Decide on the flag:
- If Yjs collab is considered stable → also remove `ENABLE_SCRIPT_YJS_COLLAB` and the `collaborationRequired` ternary at line 733.
- If you want a kill-switch → keep the flag, delete only the effect, and accept that flipping the flag now means "no sync at all" (document that next to the flag).

**Verify first:** `grep -n "ENABLE_SCRIPT_YJS_COLLAB" plotwell-app/src -r` — confirm still exactly 3 references and the flag is still `true`.

## C3. Backend dependencies

**Remove from `plotwell-backend/package.json` `dependencies` (verified unused):**
- `pg` and `@types/pg` — zero imports; the repo convention mandates the Supabase client anyway.
- `fluent-ffmpeg` — zero imports (`videoStitchService.ts` spawns the `ffmpeg-static` binary directly). Also remove `@types/fluent-ffmpeg` from devDependencies.
- `y-websocket` — only appears in a code comment (`collaborationServer.ts:602` describes the *client* library). The server implements the protocol with `ws` + `yjs` + `lib0` directly.

**Keep:** `yjs`, `lib0`, `y-prosemirror`, `ws`, `multer`, `nodemailer` — all verified imported.

**`@types/multer`, `@types/nodemailer`, `@types/ws` are in `dependencies` — leave them there for now.** This is deliberate-looking, not sloppy: `render.yaml` prod service sets `NODE_ENV=production`, and npm 7+ defaults to `--omit=dev` when `NODE_ENV=production`, so devDependencies may be skipped at build time. Moving them breaks the prod build unless you also change the build command. If you want the cleanup, do it as one atomic change:
1. `buildCommand: npm install --include=dev && npm run build` in both render.yaml services.
2. Move all `@types/*` to devDependencies.
3. Confirm a Render deploy succeeds before merging anything else on top.

(Worth checking anyway: `typescript` is already in devDependencies, so either Render's npm is currently installing devDeps despite NODE_ENV — in which case the move is safe — or prod builds are working by accident. Test on the dev service first.)

**Verify first:** `cd plotwell-backend && for d in pg fluent-ffmpeg y-websocket; do echo "== $d =="; grep -rn "from ['\"]$d" src --include=*.ts; done` — all three must be empty.

## C4. Dead i18n keys (57 keys)

Classification method: a key is *dead* only if it has no exact-string match in `src` AND does not belong to a dynamically-built family. The dynamic families in this codebase are `storyboard.shot_types.*`, `storyboard.camera_movements.*`, `storyboard.lighting_options.*`, `storyboard.mood_options.*` (built via `` t(`storyboard.shot_types.${...}`) `` in `PanelCard.tsx` / `PanelEditModal.tsx`). None of the keys below are in those families.

**Delete from `en.json` (8 keys, unused everywhere):**
`ui.edit`, `ui.delete`, `ui.add`, `ui.save`, `ui.generate_with_ai`, `ui.wait_for_generation`, `ui.export_pdf`, `ui.remove`

**Delete from `es.json` (49 keys, unused everywhere):** the old storyboard UI block — `storyboard.description`, `storyboard.select_scene`, `storyboard.select_scene_placeholder`, `storyboard.loading_panels`, `storyboard.error_loading_scenes`, `storyboard.error_loading_panels`, `storyboard.scene_number`, `storyboard.delete_panel`, `storyboard.delete_panel_confirm`, `storyboard.duration_placeholder`, `storyboard.image`, `storyboard.image_hint`, `storyboard.remove_image_confirm`, `storyboard.image_generated`, `storyboard.image_generation_failed`, `storyboard.linked_characters_hint`, `storyboard.linked_location_hint`, `storyboard.no_characters_available`, `storyboard.no_locations_available`, `storyboard.fill_with_ai_*` (5 keys), `storyboard.export_pdf`, `storyboard.export_pdf_generating`, `storyboard.export_pdf_success`, `storyboard.export_pdf_failed`, `storyboard.drag_to_reorder`, `storyboard.reorder_success`, `storyboard.reorder_failed`, the whole `storyboard.image_generation.*` object (16 keys), `storyboard.empty_state_title`, `storyboard.empty_state_description`

**Verify first:** re-run the classifier before deleting (key usage may have changed). Script approach: flatten both locale JSONs, diff key sets, and for each asymmetric key check (a) exact quoted match in `src` excluding `i18n/locales`, (b) membership in a dynamic-prefix family. Anything matching (a) or (b) is alive.

## C5. Permanently-disabled floating toolbar JSX in the script editor

**Problem:** `ScriptViewNew.tsx` renders a "draggable floating card (Studio mode)" block gated by `{false && inlineToolbar && ...}` — ~190 lines of JSX that can never render. It also contains an imperative drag implementation that attaches `document`-level `mousemove`/`mouseup` listeners without ever removing them; harmless today only because the block is dead.

**Evidence:** `plotwell-app/src/components/views/ScriptViewNew.tsx:2693-2881` (the `false &&` is at 2693).

**Fix:** delete the whole conditional block. If the floating toolbar is ever wanted back, it's in git history — and the drag logic should be rewritten with listener cleanup before reviving it.

**Verify first:** `grep -n "false && inlineToolbar" plotwell-app/src/components/views/ScriptViewNew.tsx` — confirm the gate is still hardcoded `false`.

---

# D. UI fixes

## D1. Studio "Plan" view shows raw i18n keys in English (bug, do first)

**Problem:** 25 keys exist **only in `es.json`**. `fallbackLng` is `'en'` (`src/i18n/index.ts:65`), so when the key is missing in EN, i18next renders the raw key string. English users see `studio.plan.tiles.storyboard_desc` instead of text. All 25 are actively used in code.

**Keys to ADD to `en.json`:**
- The whole `studio.plan.*` family (24 keys): `title`, `subtitle`, `group.visual`, `group.plan`, `group.crew`, `back_to_overview`, and `tiles.{dashboard,storyboard,breakdown,shot_list,stripboard,filming_locations,budget,cast,callsheets}` each with its `_desc` variant.
- `storyboard.generate_image`

Translate from the Spanish values already in `es.json` (they are the source of truth here).

**Verify first:** open the Studio Plan view with the app language set to English; the raw keys are visible.

## D2. Spanish users see English text in storyboard toasts (12 keys)

**Problem:** 12 actively-used keys exist only in `en.json`; Spanish users get the English fallback.

**Keys to ADD to `es.json`:** `storyboard.generating`, `storyboard.panel_added_title`, `storyboard.panel_added_message`, `storyboard.panel_updated_title`, `storyboard.panel_updated_message`, `storyboard.panel_deleted_title`, `storyboard.panel_deleted_message`, `storyboard.image_generated_title`, `storyboard.image_generated_message`, `storyboard.image_removed_title`, `storyboard.image_removed_message`, `ui.generate_image`

## D3. `window.location.href = '/login'` on logout — keep, but document

**Evidence:** `plotwell-app/src/lib/auth.ts:44` inside `signOut()`. Technically violates the "internal navigation uses navigate()" rule.

**Verified context:** `signOut` is a plain module function (no hook context, `navigate()` unavailable) with a single caller (`StudioTopBar.tsx:143`). A full page load on logout is actually *desirable*: it flushes all in-memory state (contexts, caches, Yjs docs) so nothing from the previous session can leak into the next login.

**Fix:** don't change the behavior. Add a one-line comment marking it as a deliberate exception ("full reload on purpose: clears all in-memory state on logout"), so future audits and reviewers don't re-flag it. All other `window.location.href` uses in the app are external URLs (Stripe checkout/portal, landing) and are allowed by the convention.

---

# E. Functional bugs

## ✓ E1. Production schedule is silently broken for collaborators (FIXED)

Removed all 4 `.eq('user_id', userId)` filters from `scheduleService` (`assignSceneToDate`, `optimizeSchedule` read+batch, `clearSchedule`). Also added project access check in PUT `/schedule/scene/:sceneId` route (was missing because path has no `:projectId`). Collaborators now see the full schedule and their edits persist.

---

# Suggested PR breakdown

| PR | Contents | Risk |
| --- | --- | --- |
| 0. **Production access control** (do first) | A5 (all unprotected production endpoints) + A6 (document version 403) + E1 (drop `user_id` filters in scheduleService) | Medium — touches many endpoints, but the pattern is mechanical; test owner, collaborator (editor + viewer), and outsider against each route |
| 1. i18n fixes | D1 + D2 (add 37 translations), C4 (delete 57 dead keys) | None — JSON only, fixes a visible EN bug |
| 2. Share-link hardening | A1 + A2 | Low — keep dual-format hash compare for existing links |
| 3. Frontend dead code | C1 (14 files) + C2 (dormant effect) + C5 (false-gated toolbar block) + D3 (comment) | Low — build verifies |
| 4. Backend cleanup | B1 (storage calls) + C3 deps (`pg`, `fluent-ffmpeg`, `y-websocket` only) | Low |
| 5. AI usage tracking | A3 (4 call sites) + the `analysis.ts` metering chain from A5 | Medium — touches billing-adjacent accounting, test with DEBUG_AI |
| 6. Video status batching | B2 stage 1 | Medium — coordinate frontend+backend |
| 7. (later) Replicate webhooks | B2 stage 2 | Higher — new public endpoint with signature validation |
| 8. (later) @types/devDeps + render.yaml | C3 build-command change | Test on dev service first |

A4 (durable rate-limit store) stays on the backlog until there's evidence of abuse or multi-instance scaling.
