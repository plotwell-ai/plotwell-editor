# plotwell Server Architecture

**Last Updated**: April 5, 2026

---

## Overview

Express 5 + TypeScript backend serving the plotwell screenplay editor. Key characteristics:

- **Database**: Supabase PostgreSQL via `@supabase/supabase-js` (service_role key, bypasses RLS)
- **Auth**: JWT verification (ES256 via JWKS + HS256 legacy fallback)
- **Rate limiting**: Per-user with IP fallback (`express-rate-limit`)
- **AI integration**: Replicate API with extended timeouts and request deduplication
- **Real-time**: WebSocket collaboration via Yjs CRDT
- **Payments**: Stripe (see `BILLING_SYSTEM.md`)
- **Security**: Helmet, CORS allowlisting, IP allowlist, input validation, error sanitization

---

## Server Setup

### Environment Loading

Environment files are loaded via `--env-file` arg passed to `ts-node`:

```bash
ts-node src/server.ts --env-file=.env.local
```

`dotenv.config({ path: envPath, override: true })` runs before any imports. The `override: true` flag is required because dotenv v17 auto-preloads `.env` before the explicit config call.

### Timeouts

| Layer | Timeout | Purpose |
|-------|---------|---------|
| Request (`req.setTimeout`) | 11 min | AI route middleware, per-request |
| Server (`server.timeout`) | 12 min | Global server timeout |
| Keep-alive (`server.keepAliveTimeout`) | 13 min | Prevents premature connection drops |

Epic/complex AI requests override the 11-min default: epic gets 15 min, complex gets 12 min.

### Health Check

`GET /health` (unauthenticated) verifies database connectivity. Returns `{ status: 'healthy', db: 'connected' }` or 503 with `{ status: 'unhealthy', db: 'unreachable' }`. Used by Render and monitoring.

### Background Tasks

- **Operation lock cleanup**: Runs every 5 minutes via `cleanupExpiredLocks()` to remove expired rows from `operation_locks` table
- **Collaboration room cleanup**: Runs every 5 minutes to garbage-collect empty WebSocket rooms
- **Soft-delete purge**: Runs every 24 hours, hard-deletes projects with `deleted = true` and `updated_at` older than 90 days

### Graceful Shutdown

`SIGTERM` and `SIGINT` both close the WebSocket collaboration server, then shut down the HTTP server (30-second force-exit timeout). `uncaughtException` and `unhandledRejection` also close collaboration before exiting with code 1.

### Trust Proxy

`app.set('trust proxy', 1)` trusts the first proxy (Render/Vercel) so `req.ip` returns the real client IP.

---

## Authentication

**Middleware**: `requireAuth` in `src/middleware/auth.ts`

1. Extracts `Bearer <token>` from `Authorization` header
2. Decodes JWT header to check algorithm
3. **ES256 + kid**: Verifies signature via JWKS endpoint (`SUPABASE_URL/auth/v1/.well-known/jwks.json`). JWKS responses are cached for 10 minutes.
4. **HS256**: Verifies with `SUPABASE_JWT_SECRET` (legacy fallback)
5. Extracts `sub` claim as user ID, attaches to `req.user.id`

**Project access**: `checkProjectAccess` verifies ownership or active collaborator status. `checkProjectAccessByRecordId(tableName, requireWriteAccess?)` looks up a record's `project_id` first, then checks access. When `requireWriteAccess` is `true`, viewers are blocked (only editor/admin/owner allowed).

---

## CORS

Dynamic origin allowlisting configured in `server.ts`:

- **Non-production**: `localhost:5173` through `localhost:5178`
- **All environments**: `FRONTEND_URL` env var (comma-separated for multiple origins)
- Credentials enabled (`credentials: true`)

---

## Route Mounting Order

Order matters. The webhook route **must** come before `express.json()` to preserve the raw body for Stripe signature verification.

```
1.  helmet()                              -- Security headers
2.  errorSanitizer                        -- Intercepts res.json() for production error stripping
3.  CORS                                  -- Origin allowlisting
4.  ipAllowlistMiddleware                 -- Optional IP restriction
5.  /health                               -- Health check (unauthenticated)
6.  /api/billing/stripe-webhook           -- BEFORE JSON parser (raw body needed)
7.  express.json({ limit: '10mb' })       -- Default JSON parsing
    express.urlencoded({ limit: '10mb' }) -- URL-encoded body parsing
8.  /api/billing                          -- Unified billing (auth + billingLimiter)
9.  /api/ai (task-events SSE)             -- AI task push notifications (no auth, no rate limit)
10. /api/ai                               -- AI routes (auth + aiLimiter + extendedTimeout)
11. /api/pricing                          -- Public (no auth)
12. /api/collaboration                    -- Mixed auth (per-route)
13. /api/share                            -- Public share (per-route auth, public GET)
14. /api/projects                         -- Protected CRUD (auth + crudLimiter)
15. /api (seasons, episodes, beats,       -- Protected CRUD (auth + crudLimiter)
    structure-templates)
16. /api/characters                       -- Protected CRUD (auth + crudLimiter)
17. /api/characters/:characterId/images   -- Protected (auth + uploadLimiter)
18. /api/characters/:characterId/elements -- Protected (auth + crudLimiter)
19. /api/locations                        -- Protected CRUD (auth + crudLimiter)
20. /api/locations/:locationId/images     -- Protected (auth + uploadLimiter)
21. /api/documents                        -- Protected CRUD (auth + crudLimiter)
22. /api/scripts, /api (import)           -- Protected, 50mb payload limit
23. /api/storyboard                       -- Protected (auth + uploadLimiter)
24. /api/conversations                    -- Protected CRUD (auth + crudLimiter)
25. /api/usage                            -- Protected (auth)
26. /api/ai-credits                       -- Protected (auth + aiCreditsLimiter)
27. /api/production                       -- Protected + extendedTimeout
28. /api/user                             -- Protected (auth + userLimiter)
29. /api/comments                         -- Protected CRUD (auth + crudLimiter)
30. /api/script-doctor/v2                 -- Protected + scriptDoctorLimiter + extendedTimeout
```

---

## Rate Limiting

All limiters key by `req.user.id` when available, falling back to IP.

| Limiter | Max/min | Applied to | Notes |
|---------|---------|------------|-------|
| `aiLimiter` | 5 | `/api/ai` | AI generation endpoints |
| `scriptDoctorLimiter` | 15 | `/api/script-doctor/v2` | Higher limit (includes GET analyses) |
| `billingLimiter` | 10 | `/api/billing` | Payment/subscription endpoints |
| `aiCreditsLimiter` | 5 | `/api/ai-credits` | Credit purchase endpoints |
| `crudLimiter` | 60 | Most CRUD routes | Skips GET requests |
| `uploadLimiter` | 10 | `/api/storyboard`, character images, location images | File upload endpoints |
| `userLimiter` | 30 | `/api/user` | User profile/subscription polling |

---

## Middleware Chain Patterns

### Standard CRUD

```
requireAuth -> crudLimiter -> router handler
```

### AI Operations (Full Chain)

```
requireAuth -> extractUserId -> preventDuplicate -> addPricingService
  -> addAIUsageTracker -> extractProjectId -> fullRequestClassification(type)
  -> checkAIGenerationLimit -> trackAIUsage -> handler
```

Each step in the chain:

| Middleware | File | Purpose |
|-----------|------|---------|
| `requireAuth` | `auth.ts` | JWT verification, populates `req.user` |
| `extractUserId` | `pricingMiddleware.ts` | Copies `req.user.id` to `req.userId` |
| `preventDuplicate*` | `requestDeduplication.ts` | DB-backed lock dedup, returns 409 if duplicate in progress |
| `addPricingService` | `pricingMiddleware.ts` | Attaches `PricingService` instance to request |
| `addAIUsageTracker` | `aiUsageMiddleware.ts` | Attaches usage tracker, sets `aiStartTime` and `aiRequestId` |
| `extractProjectId` | `aiUsageMiddleware.ts` | Copies `project_id` from body/params/query to `req.projectId` |
| `fullRequestClassification(type)` | `requestClassificationMiddleware.ts` | Returns array of 3 sub-middleware: `classifyAIRequest` -> `handleRequestQueue` -> `applyRequestOptimizations` |
| `checkAIGenerationLimit` | `pricingMiddleware.ts` | Alias for `checkAICreativeTaskLimit`; blocks if quota exceeded (free: lifetime cap, paid: credit balance) |
| `trackAIUsage` | `pricingMiddleware.ts` | Intercepts `res.json()` to increment usage counter / consume credits after successful response |

### AI Image/Credit Operations

Additional middleware for image generation and credit-consuming operations:

| Middleware | File | Purpose |
|-----------|------|---------|
| `checkAICredits` | `pricingMiddleware.ts` | Checks credit balance before image/video generation (alias: `checkImageCredits`) |
| `trackAICreditsUsage` | `pricingMiddleware.ts` | Consumes credits after successful generation (alias: `trackImageUsage`) |
| `checkWritePermissions` | `pricingMiddleware.ts` | Blocks viewers from write operations; resolves `project_id` from storyboard panels if needed |
| `requireFeature(name)` | `pricingMiddleware.ts` | Blocks if user's plan lacks the named feature (e.g., `storyboards`, `agent_writer`) |
| `checkProjectLimit` | `pricingMiddleware.ts` | Blocks project creation if plan limit reached |
| `checkCollaboratorLimit` | `pricingMiddleware.ts` | Blocks adding collaborators if plan limit reached |

### Production Operations

| Middleware | File | Purpose |
|-----------|------|---------|
| `checkProductionPrerequisites` | `productionPrerequisitesMiddleware.ts` | Blocks if project has no script or no scenes; attaches `req.productionStatus` |
| `attachProductionStatus` | `productionPrerequisitesMiddleware.ts` | Non-blocking variant; attaches status for GET endpoints |
| `requireSyncedScenes` | `productionPrerequisitesMiddleware.ts` | Blocks if no production scenes exist (used by "Fill with AI" etc.) |

---

## Request Deduplication

**File**: `src/middleware/requestDeduplication.ts`

- Creates SHA256 hash from `userId + operationType + projectId + content(MD5)`
- Uses **database-backed locks** via `operationLockService.ts` (`operation_locks` table) for multi-instance safety
- Returns **409** with request hash on duplicate
- Lock released automatically on response `finish`/`close` events, or expires after configurable timeout
- Expired locks cleaned up every 5 minutes by background interval in `server.ts`

| Operation | Timeout |
|-----------|---------|
| Treatment generation | 10 min |
| Storyboard generation | 10 min |
| Character/location generation | 5 min |
| Storyboard image generation | 5 min |
| Character/location image generation | 3 min |
| Beat suggest/analyze/expand | 2 min |
| Beat description generation | 1 min |

---

## Request Classification

**File**: `src/middleware/requestClassificationMiddleware.ts`

`fullRequestClassification(requestType)` is a factory that returns an array of three middleware:

1. **`classifyAIRequest(type)`** -- Builds project context via `AITokenService`, classifies complexity, sets response headers
2. **`handleRequestQueue`** -- Delays queued requests (placeholder for future queue system)
3. **`applyRequestOptimizations`** -- Adjusts timeouts and sets priority/chunking headers

Valid `requestType` values: `chat`, `script-generation`, `concept-generation`, `character-generation`, `location-generation`, `storyboard-generation`, `feature-screenplay`.

**Response headers set:**

- `X-AI-Complexity`: simple, standard, complex, epic
- `X-AI-Strategy`: processing strategy
- `X-AI-Estimated-Duration`: seconds
- `X-AI-Estimated-Tokens`: token count

**Timeout overrides**: epic requests get 15-min timeout, complex gets 12-min.

---

## Security Middleware

### Archive Middleware (`archiveMiddleware.ts`)

Blocks mutations on archived projects. Returns 403 with message. Two variants:
- `checkProjectArchived` -- reads `project_id` from `req.params.projectId`, `req.params.project_id`, or `req.body.project_id`
- `checkProjectArchivedByRecordId(tableName, paramName?)` -- looks up `project_id` from a record in `tableName` using `req.params[paramName]` (defaults to `'id'`)

### Input Validation (`inputValidation.ts`)

Field length limits enforced before processing:

| Limit Key | Max Chars | Fields |
|-----------|-----------|--------|
| `aiPrompt` | 50,000 | question, questionForAI, content, prompt, context, instructions, feedback, notes |
| `comment` | 10,000 | content, text |
| `name` | 500 | Character/project names |
| `description` | 5,000 | Descriptions, notes |

Returns 413 if exceeded.

### AI Usage Tracking (`aiUsageMiddleware.ts`)

Middleware and helper functions for tracking AI API usage (tokens, image generations):

| Export | Purpose |
|--------|---------|
| `addAIUsageTracker` | Middleware: attaches `AIUsageTracker` to `req.aiUsageTracker`, sets `req.aiStartTime` and `req.aiRequestId` |
| `setOperationType(type)` | Middleware factory: sets `req.aiOperationType` for downstream tracking |
| `extractProjectId` | Middleware: copies `project_id` from body/params/query to `req.projectId` |
| `trackOpenAIUsageInRoute(req, ...)` | Helper function called inside route handlers after AI text generation completes |
| `trackImageUsageInRoute(req, ...)` | Helper function called inside route handlers after image generation completes |

### Error Sanitization (`errorSanitizer.ts`)

In production, intercepts `res.json()` on 4xx/5xx responses:
- Strips `details` field
- Replaces error messages matching internal patterns (DB errors, stack traces, TypeErrors) with "Internal server error"
- Passes through in development

### IP Allowlist (`ipAllowlist.ts`)

Optional. Set `ALLOWED_IPS=1.2.3.4,5.6.7.8` to restrict access. If unset or empty, all IPs are allowed.

---

## Database Configuration

**File**: `src/config/database.ts`

```typescript
export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});
```

Uses `service_role` key which **bypasses RLS**. Ownership checks are enforced in application code (`.eq("user_id", userId)` on queries).

---

## Deployment

### Render

| Branch | Service | URL |
|--------|---------|-----|
| `dev` | plotwell-backend-dev | `plotwell-backend-dev.onrender.com` |
| `main` | plotwell-backend-prod | `plotwell-backend-prod.onrender.com` |

Default port: `process.env.PORT || 3001` (Render uses port 10000).

### Required Environment Variables

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_JWT_SECRET
```

Missing vars are logged at startup but don't prevent boot.

### Dev Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev:local` | Local dev with `.env.local` |
| `npm run dev:dev` | Local dev pointing to Render dev backend |
| `npm run dev:prod` | Local dev pointing to Render prod backend |
| `npm run build` | Compile TypeScript (`tsc`) |
| `npm start` | Run compiled `dist/server.js` |

---

## Common Gotchas

1. **Stripe webhook must be mounted before `express.json()`.** The webhook route needs the raw request body for signature verification. If JSON parsing runs first, Stripe rejects the signature.

2. **`service_role` key bypasses all RLS policies.** Every query must include explicit ownership checks (`.eq("user_id", userId)`). Forgetting this exposes other users' data.

3. **AI routes need extended timeout middleware.** Without it, long generation requests (screenplay, storyboard) will timeout at the default Node.js 2-min limit.

4. **Collaboration uses the project owner's quotas, not the collaborator's.** AI generation limits and project counts are checked against the owner, even when a collaborator triggers the action.

5. **Request deduplication is database-backed.** Uses `operation_locks` table for multi-instance safety. Locks survive server restarts. Expired locks are cleaned up every 5 minutes.

6. **`extractUserId` middleware is required for AI routes.** Without it, `req.userId` is undefined even though `req.user.id` exists. Many services read from `req.userId`.

7. **CORS allows ports 5173-5178 only in non-production.** If you run the frontend on a different port locally, requests will be blocked.

8. **Payload limits differ by route.** Default is 10mb, but scripts and import routes use 50mb (`largePayload` middleware) for large screenplay content.
