# Backend Guide

Backend code lives in `plotwell-backend/`.

## Route Patterns

Routes are mounted from `src/server.ts`.

- Public routes include `/api/pricing`.
- Protected routes use `requireAuth`, for example projects, scripts, locations, and collaboration resources.
- AI routes use the AI rate-limit and usage-tracking middleware chain.
- Production routes may use extended timeouts.

See `plotwell-backend/docs/SERVER_ARCHITECTURE.md` for the full route table and middleware chain.

## Auth

JWTs come through:

```text
Authorization: Bearer <token>
```

Use `requireAuth` and `extractUserId` before code reads `req.userId`.

## Database Access

Use the Supabase client.

```typescript
import { supabase } from "@/config/database";
```

Do not introduce direct PostgreSQL pool usage unless the data layer is being intentionally redesigned.

For updates and deletes, include ownership or collaborator access checks. Typical single-owner mutations include `.eq("user_id", userId)`.

## AI Middleware Order

Use the full chain for protected AI operations:

```text
requireAuth
  -> extractUserId
  -> preventDuplicate
  -> addPricingService
  -> fullRequestClassification
  -> checkAIGenerationLimit
  -> trackAIUsage
  -> handler
```

## Responses

Success:

```typescript
res.json(data);
```

Errors:

```typescript
res.status(400).json({
  error: "Human-readable message",
  error_type: "optional_type",
  message: "optional detail",
  redirect_to: "optional path",
});
```

Keep error formats consistent and avoid leaking internal errors or secrets.

## Backend Docs

Read the relevant service doc before larger changes:

- `plotwell-backend/README.md`
- `plotwell-backend/docs/AI_SERVICE.md`
- `plotwell-backend/docs/BILLING_SYSTEM.md`
- `plotwell-backend/docs/PRODUCTION_SERVICE.md`
- `plotwell-backend/docs/SCRIPT_SERVICE.md`
- `plotwell-backend/docs/COLLABORATION_SERVICE.md`
- `plotwell-backend/docs/CORE_SERVICES.md`
- `plotwell-backend/docs/SERVER_ARCHITECTURE.md`
