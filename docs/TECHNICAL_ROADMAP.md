# plotwell - Technical Roadmap: Security, Scalability & Production Readiness

**Last Updated**: March 27, 2026 | **Status**: Early production, scaling preparation

---

## 1. Executive Summary

plotwell is functional and serving users, but has gaps that must be addressed before scaling. This roadmap prioritizes by impact: security fixes and code-level improvements first (things we can do now with our existing stack), then third-party integrations and infrastructure additions.

**Current State**: Single Render instance, DB-backed operation locks, health check endpoint, input validation + error sanitization middleware, idempotency on payment operations, console.log logging, no monitoring, no tests, no background jobs.

**Target State**: Multi-instance ready, monitored, tested, GDPR compliant.

---

## 2. What's Been Fixed (Since Initial Audit)

These items from the original audit are now resolved:

| # | Issue | Resolution |
|---|-------|------------|
| S1 | No health endpoint | `GET /health` with DB check shipped |
| S9 | Image upload path not sanitized | `sanitizeFileName()` in imageService -- discards original filename, uses timestamp |
| S10 | No payment idempotency keys | DB-backed `operationLockService` + Stripe-native idempotency keys on customer/checkout creation |
| I1 | In-memory operation locks | Migrated to DB-backed `operation_locks` table |
| I12 | No graceful shutdown | Drain connections before exit implemented |
| I13 | No WebSocket room cleanup | Room cleanup interval for empty rooms added |
| M14 | Stripe refund tracking | `processRefundForSubscription` in stripeService + prorated refunds in unifiedBillingService |
| M18 | Scene insertion replace mode | `case 'replace'` branch implemented in sceneInsertionService |
| -- | No input validation | `inputValidation.ts` middleware with field-length limits (Zod-style) |
| -- | Error response leaks internals | `errorSanitizer.ts` strips DB schema, stack traces, Supabase internals in production |

---

## 3. Open Findings

### Security (Medium)

| # | Issue | Fix | Requires |
|---|-------|-----|----------|
| S7 | No rate limit on `/api/user/subscription/:userId` | Apply `userLimiter` | Code only |
| S8 | 6 inline `new Stripe()` in `unifiedBilling.ts` route file | Refactor to use centralized `stripeService` singleton | Code only |
| S11 | Helmet uses default config, no custom CSP | Configure helmet with explicit `Content-Security-Policy` directives | Code only |
| S12 | Webhook error leaks Stripe internals | Return generic error, log details server-side | Code only |
| M13 | Stripe dispute handler is empty stub | Implement `handleChargeDisputeCreated` | Code only |

### Scalability

| # | Issue | Fix | Requires |
|---|-------|-----|----------|
| I2 | WebSocket rooms in-memory only -- blocks multi-instance | Redis pub/sub for Y.js sync, or sticky sessions | **Redis** |
| I3 | Single Render instance -- no failover | Increase to 2+ instances | **Redis + Render** |
| I6 | No query result caching | Cache with 5-min TTL, invalidate on mutation | **Redis** |
| I14 | Frontend bundle size not analyzed | Add rollup-plugin-visualizer, optimize large chunks | Code only |
| I15 | No CDN for images/assets | Deploy static assets to CDN | **Cloudflare** |

### Missing Features

| # | Feature | Requires |
|---|---------|----------|
| M1 | Error tracking | **Sentry** |
| M3 | Structured logging (replace console.log) | **pino** (npm) |
| M4 | Database backup strategy documentation | Supabase dashboard |
| M5 | Background job system | **Bull/BullMQ + Redis** |
| M6 | Automated tests | Code only |
| M7 | CI/CD pipeline | **GitHub Actions** |
| M11 | Two-factor authentication | Supabase Auth config |
| M12 | Audit logging for account changes | Code only |
| M20 | API documentation | **Swagger** (npm) |
| M21 | Feature flags system | Code only |
| M22 | React Error Boundaries | Code only |
| M23 | Accessibility (aria labels, sr-only) | Code only |

### Incomplete Implementations

| # | Feature | File | Status |
|---|---------|------|--------|
| M13 | Stripe dispute handler | `stripeWebhookService.ts` | Empty stub |
| M15 | Welcome email after signup | `stripeWebhookService.ts` | TODO comment |
| M16 | Document DOCX export | `DocumentEditor.tsx` | TODO stub; backend outputs plain text as .docx |
| M19 | 6 deprecated billing endpoints | `user.ts`, `pricing.ts` | Return 501 -- remove when safe |

---

## 4. Implementation Roadmap

### Phase 1: Code-Level Security & Cleanup -- DO NOW

**Goal**: Fix everything we can with zero new dependencies. Pure code changes.

- [x] Health endpoint, graceful shutdown, room cleanup, operation locks, path sanitization, idempotency, input validation, error sanitizer (all shipped)
- [ ] **S8**: Refactor unifiedBilling.ts to use stripeService singleton (3h)
- [ ] **S7**: Add rate limiter to subscription endpoint (1h)
- [ ] **S11**: Configure helmet with custom CSP (2h)
- [ ] **S12**: Fix webhook error response to not leak Stripe internals (1h)
- [ ] **M13**: Implement Stripe dispute handler (2h)
- [ ] **M22**: React Error Boundaries on all route components (2h)
- [ ] **M12**: Audit logging for account changes (8h)
- [ ] **M15-M16**: Complete remaining TODO implementations (8h)
- [ ] **M19**: Remove deprecated 501 endpoints (when safe) (2h)

**Total**: ~29h | **External dependencies**: None

---

### Phase 2: Testing & CI/CD

**Goal**: Confidence to ship fast without breaking things.

- [ ] **M7**: GitHub Actions CI/CD (lint, build, deploy) (8h)
- [ ] **M6**: Add tests for critical paths (billing, auth, AI credits) (40h)
- [ ] **M21**: Feature flags system (code-only, no external service) (8h)
- [ ] **I14**: Frontend bundle optimization (analyze, split, lazy-load) (8h)
- [ ] **M4**: Document and verify Supabase backup strategy (4h)

**Total**: ~68h | **External dependencies**: GitHub Actions (free tier)

---

### Phase 3: Third-Party Integrations

**Goal**: Add external services for observability, logging, and documentation.

| # | Task | Service | Effort |
|---|------|---------|--------|
| M1 | Error tracking + APM | **Sentry** | 4h |
| M3 | Structured logging (replace console.log) | **pino** (npm package) | 8h |
| M20 | API documentation | **Swagger/OpenAPI** (npm package) | 16h |
| I15 | CDN for images and static assets | **Cloudflare** | 4h |
| M11 | Two-factor authentication | Supabase Auth (config) | 8h |
| M23 | Accessibility audit and fixes | Code + tooling | 16h |

**Total**: ~56h | **New services**: Sentry, Cloudflare CDN

---

### Phase 4: Horizontal Scaling (When needed, ~100+ concurrent users)

**Goal**: Prepare for multi-instance deployment. All items here require Redis.

| # | Task | Effort |
|---|------|--------|
| -- | Provision Redis instance (Render/Upstash) | 2h |
| I2 | WebSocket scaling -- Redis pub/sub for Y.js sync | 16h |
| I3 | Add second Render instance + health probes | 4h |
| I6 | Query result caching for hot paths (Redis, 5-min TTL) | 8h |
| M5 | Background job system (Bull/BullMQ + Redis) for emails, cleanup, reconciliation | 12h |

**Total**: ~42h | **New services**: Redis (Render Redis or Upstash)

---

## 5. Priority Matrix

```
                    HIGH IMPACT
                        |
         +--------------+--------------+
         |  DO NOW      |  PLAN NEXT   |
         |  (code only) | (code + CI)  |
         |              |              |
         |  S7,S8,S11   |  M6,M7       |
         |  S12,M13     |  M21         |
         |  M22         |              |
  LOW ---+--------------+--------------+--- HIGH
 EFFORT  |              |              |  EFFORT
         |  BATCH       |  DEFER       |
         | (3rd party)  | (infra)      |
         |              |              |
         |  M1,M3       |  I2,I3,M5   |
         |  M11,I15     |  M20,M23    |
         |              |  I14        |
         |              |              |
         +--------------+--------------+
                        |
                    LOW IMPACT
```

---

## 6. Estimated Timeline

| Phase | Focus | Effort | Status |
|-------|-------|--------|--------|
| Phase 1 | Code-level security & cleanup | ~29h | Ready to start (no blockers) |
| Phase 2 | Testing & CI/CD | ~68h | After Phase 1 |
| Phase 3 | Third-party integrations | ~56h | When ready to add services |
| Phase 4 | Horizontal scaling (Redis) | ~42h | When approaching ~100 concurrent users |

**Phase 1 has zero dependencies** -- all items are pure code changes we can do today.

**Phase 2 only needs GitHub Actions** (free) -- gives us CI/CD and test coverage.

**Phase 3 is independent** -- can run in parallel with Phase 2. Each service (Sentry, Cloudflare, pino) can be added one at a time.

**Phase 4 is the big infrastructure change** -- adding Redis unlocks multi-instance, caching, and background jobs all at once. Defer until user growth demands it.

---

## 7. Infrastructure Target Architecture

```
Current:
  Vercel (frontend) -> Single Render (backend) -> Supabase (DB + operation_locks)

Target (after Phase 4):
  Vercel (frontend + landing)
    |
    +-- Render Instance 1 --+
    +-- Render Instance 2 --+-- Redis (WebSocket sync, cache, pub/sub)
    |                       |
    |                       +-- Supabase PostgreSQL (data + operation locks)
    |                       +-- Supabase Storage (files)
    |                       +-- Stripe (payments)
    |
    +-- Sentry (error tracking)
    +-- Amplitude (analytics)
    +-- Cloudflare CDN (static assets)
    +-- Background Worker (Bull + Redis)
         +-- Email queue
         +-- Cleanup jobs
         +-- Reconciliation jobs
```

---

## 8. Key Metrics to Track

| Metric | Current | Target | How to Measure |
|--------|---------|--------|---------------|
| Error rate | Unknown | < 0.1% | Sentry (Phase 3) |
| P95 API latency | Unknown | < 500ms | Structured logs (Phase 3) |
| Uptime | Unknown | 99.9% | Health check monitoring |
| Test coverage | 0% | > 60% critical paths | Jest/Vitest (Phase 2) |
| Time to first byte | Unknown | < 200ms | Vercel analytics |
| WebSocket reconnection rate | Unknown | < 5% | Custom metric |
| AI cost per user/month | Unknown | < 0.50 EUR | Usage tracking |
| DB query count per page | Unknown | < 20 | Structured logs (Phase 3) |
