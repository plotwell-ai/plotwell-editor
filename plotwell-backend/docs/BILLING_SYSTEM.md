# plotwell Billing System

**Last Updated**: April 5, 2026

---

## Overview

plotwell uses a two-tier subscription model (Free / Pro) with optional paid addons, powered by Stripe. The system is designed to work **without webhooks** as the primary path, using webhooks only as a safety net for edge cases.

---

## Plans & Pricing

### Free Plan (`plan_id: 'free'`)
- 0 projects, 0 collaborators, 0 documents (must subscribe to access)
- 0 AI creative tasks
- No storyboards, version control, comments, or agent writer

### Pro Plan (`plan_id: 'paid'`)
- 2 projects, 2 collaborators, unlimited documents
- AI credit system (1 credit per creative task, 2 credits per agent step, 10 credits per image)
- Storyboards, version control, comments, agent writer, priority support
- **Monthly**: $5/month
- **Yearly**: $50/year
- **Free trial**: 14 days for yearly plans (new users only, never previously subscribed)

### Addons (Pro plan only)
- **Additional projects**: $3/month or $30/year each
- **Additional collaborators**: $3/month or $30/year each
- No maximum limit

### AI Credits (one-time purchase)
- Small pack: 200 credits = $5
- Large pack: 500 credits = $10
- Bulk pack: 1400 credits = $20
- Credits never expire and persist across billing cycles

### AI Credit Costs

| Operation | Cost |
|-----------|------|
| Creative task (script gen, brainstorming) | 1 credit |
| Agent writer step (autonomous scene gen) | 2 credits |
| Image generation | 10 credits |
| Video (future) | 50 credits |

---

## Architecture

### Canonical Service & Routes

| Layer | File | Purpose |
|-------|------|---------|
| **Routes** | `routes/unifiedBilling.ts` | All billing API endpoints |
| **Service** | `services/unifiedBillingService.ts` | Core billing logic |
| **Stripe** | `services/stripeService.ts` | Stripe API wrapper |
| **Webhooks** | `services/stripeWebhookService.ts` | Safety-net webhook handlers |
| **Config** | `config/pricingPlans.ts` | Plan definitions & price ID mappings |
| **Currencies** | `config/currencies.ts` | USD pricing table, currency detection (returns USD) |
| **AI Credits** | `routes/aiCredits.ts` | AI credit balance, purchase, fulfillment |
| **Limits** | `services/pricingService.ts` | Limit enforcement & usage tracking |
| **Middleware** | `middleware/pricingMiddleware.ts` | Request-level limit checks |
| **Locks** | `services/operationLockService.ts` | Database-backed operation locks for billing idempotency |

### Legacy (to be retired)
- `routes/pricing.ts` - Older billing endpoints (upgrade, cancel, preview). Some endpoints still used by frontend for limit checks (`/check-limit`, `/subscription`, `/usage`). The upgrade/cancel/preview endpoints should NOT be used for new work.
- `services/subscriptionManagementService.ts` - Older subscription utilities. Use `UnifiedBillingService` instead.

### Database Tables

| Table | Purpose |
|-------|---------|
| `user_subscriptions` | Primary subscription state (plan_id, status, addons, stripe IDs, billing period) |
| `users` | Quick-lookup stripe IDs (stripe_customer_id, stripe_subscription_id) |
| `user_quotas` | AI credits balance and generation counters |
| `ai_credit_transactions` | AI credit purchase/grant history |
| `addon_transactions` | Addon purchase history (projects, collaborators) |
| `billing_events` | Audit trail for payment verifications |
| `operation_locks` | Database-backed operation locks for billing idempotency |

### Plan ID Convention

**Only two valid plan IDs**: `'free'` and `'paid'`. No legacy names (`pro`, `teams`, `business`).

### Price ID Mapping

Stripe price IDs are configured via environment variables:

```
STRIPE_PAID_MONTHLY_PRICE_ID      -> 'paid' plan (monthly)
STRIPE_PAID_YEARLY_PRICE_ID       -> 'paid' plan (yearly)
STRIPE_ADDON_PROJECT_PRICE_ID     -> additional project addon (monthly)
STRIPE_ADDON_COLLABORATOR_PRICE_ID -> additional collaborator addon (monthly)
STRIPE_ADDON_PROJECT_YEARLY_PRICE_ID     -> additional project addon (yearly)
STRIPE_ADDON_COLLABORATOR_YEARLY_PRICE_ID -> additional collaborator addon (yearly)
STRIPE_AI_CREDITS_PRICE_ID        -> AI credits (optional, credits actually use price_data)
```

`getPlanIdFromStripePrice(priceId)` maps a Stripe price ID back to a plan ID. It only recognizes the two base plan prices. Addon price IDs are NOT base plans and must not be confused with them.

---

## Subscription Lifecycle

### New Subscription (Free -> Pro)

```
Frontend                          Backend                              Stripe
   |                                |                                    |
   |-- POST /billing/preview ------>|                                    |
   |<-- cost breakdown -------------|                                    |
   |                                |                                    |
   |-- navigate to /checkout ------>|                                    |
   |-- POST /billing/change ------->|                                    |
   |   { type: 'new',              |-- createCheckoutSession() -------->|
   |     target_plan: 'paid',      |<-- session { client_secret } ------|
   |     billing_cycle: 'monthly' }|                                    |
   |<-- { client_secret } ---------|                                    |
   |                                |                                    |
   |-- Mount EmbeddedCheckout ----->|                                    |
   |-- User pays in Stripe UI ---->|                                    |
   |                                |                                    |
   |-- Redirect to /billing-return  |                                    |
   |-- POST /billing/verify-payment>|-- retrieve session --------------->|
   |                                |<-- session { payment_status } -----|
   |                                |                                    |
   |                                |-- UPDATE user_subscriptions        |
   |                                |   plan_id='paid', status='active'  |
   |                                |-- Grant 200 launch offer credits   |
   |<-- { success: true } ---------|                                    |
   |                                |                                    |
   |-- Retry poll subscription      |                   (webhook fires) |
   |   until plan_id != 'free'     |<-- customer.subscription.created --|
   |                                |   (safety net - may be redundant)  |
```

**Key rules:**
1. `plan_id` stays `'free'` until payment is verified via `/verify-payment` or `/fulfill`
2. The local DB is updated to `subscription_status: 'incomplete'` during checkout to track pending state
3. `/verify-payment` is the PRIMARY path. The webhook is a safety net only.
4. Launch offer credits (200) are granted with idempotency check (only once per user)
5. For yearly plans, new users (never subscribed before) get a 14-day free trial. `payment_status` will be `'no_payment_required'` instead of `'paid'` during trial -- both are accepted by `/verify-payment`.

### Addon Changes (Add/Remove Projects or Collaborators)

```
Frontend                          Backend                              Stripe
   |                                |                                    |
   |-- POST /billing/preview ------>|                                    |
   |   { type: 'addon_change',     |-- detectBillingCycle() ----------->|
   |     addons: { ... } }         |-- calculateProration() ------------|
   |<-- preview with prorated cost  |                                    |
   |                                |                                    |
   |-- POST /billing/change ------->|                                    |
   |   { type: 'addon_change',     |                                    |
   |     addons: {                  |                                    |
   |       additional_projects: N,  |                                    |
   |       additional_collaborators: M                                   |
   |     } }                        |                                    |
   |                                |                                    |
   |                          [ADDING ADDONS]                            |
   |                                |-- Create prorated invoice -------->|
   |                                |-- Charge immediately ------------->|
   |                                |-- syncAddonSubscriptionItems() --->|
   |                                |   (sets recurring billing)         |
   |                                |-- UPDATE user_subscriptions        |
   |                                |                                    |
   |                          [REMOVING ADDONS]                          |
   |                                |-- syncAddonSubscriptionItems() --->|
   |                                |   (removes subscription item)      |
   |                                |-- UPDATE user_subscriptions        |
   |                                |   (no refund - paid period honored)|
   |<-- { success: true } ---------|                                    |
```

**Key rules:**
1. Addons require an active paid subscription
2. Before reducing addons, validate current usage doesn't exceed new limits
3. Adding addons: immediate prorated charge for current period + recurring subscription item
4. Removing addons: **no refund** (monthly or yearly). The addon is removed from recurring billing but the user has already paid for the current period. Same policy for both billing cycles.
5. `syncAddonSubscriptionItems()` manages Stripe subscription items with `proration_behavior: 'none'` (we handle proration manually)
6. Addon items use billing-cycle-specific price IDs (monthly vs yearly are different Stripe prices)

### Cancellation (Pro -> Free)

```
Frontend                          Backend                              Stripe
   |                                |                                    |
   |-- POST /billing/preview ------>|                                    |
   |   { type: 'cancel' }          |-- Validate: active projects <= 1   |
   |                                |   collaborators <= 1               |
   |<-- preview (may be blocked     |                                    |
   |    if usage exceeds free limits)|                                   |
   |                                |                                    |
   |-- POST /billing/change ------->|                                    |
   |   { type: 'cancel' }          |-- subscriptions.update() --------->|
   |                                |   { cancel_at_period_end: true }   |
   |                                |-- UPDATE user_subscriptions        |
   |                                |   cancel_at_period_end = true      |
   |                                |   plan_id stays 'paid' until end   |
   |<-- { success: true } ---------|                                    |
   |                                |                                    |
   |              ... period ends ...                                    |
   |                                |                                    |
   |                          [DOWNGRADE - via webhook OR polling]        |
   |                                |-- Webhook: subscription.deleted -->|
   |                                |   OR                               |
   |                                |-- Polling: getSubscriptionStatus() |
   |                                |   sees no active sub in Stripe     |
   |                                |-- UPDATE plan_id='free', status=   |
   |                                |   'cancelled', addons=0            |
```

**Key rules:**
1. Cancellation is always `cancel_at_period_end: true` (user keeps access until period ends)
2. Before cancelling, the preview validates the user can fit within free plan limits
3. If blocked: frontend shows cleanup requirements (archive projects, remove collaborators)
4. When period ends, the subscription is downgraded to free (via webhook or polling fallback)
5. `stripe_customer_id` is preserved for seamless resubscription
6. AI credits persist after cancellation (they never expire)
7. **No refund** on cancellation. The user paid for the current period and keeps access until it ends.

### Reactivation (Undo Cancellation)

```
Frontend                          Backend                              Stripe
   |                                |                                    |
   |-- POST /billing/reactivate -->|                                    |
   |   -subscription               |-- subscriptions.update() --------->|
   |                                |   { cancel_at_period_end: false }  |
   |                                |-- Extract addon quantities         |
   |                                |-- UPDATE user_subscriptions        |
   |<-- { success: true } ---------|                                    |
```

**Key rules:**
1. Only valid when `cancel_at_period_end === true` and subscription is still active
2. Restores addon quantities from Stripe subscription items
3. No charge - user keeps their existing billing cycle

### AI Credits Purchase

```
Frontend                          Backend                              Stripe
   |                                |                                    |
   |-- GET /api/ai-credits/balance  |                                    |
   |<-- { balance, costs, packs } --|                                    |
   |                                |                                    |
   |-- POST /api/ai-credits/       |                                    |
   |   purchase                     |-- createCheckoutSession() -------->|
   |   { pack: 'small'|'large' }   |   mode: 'payment' (one-time)      |
   |<-- { checkout_url } ----------|                                    |
   |                                |                                    |
   |-- Redirect to Stripe --------->|                                    |
   |-- User pays ------------------>|                                    |
   |                                |                                    |
   |-- Redirect to /projects?view=usage&credits_purchased=true           |
   |-- POST /api/ai-credits/fulfill>|-- retrieve session --------------->|
   |                                |-- addAICredits() to user_quotas    |
   |<-- { credits_granted } -------|                                    |
```

**AI Credits Endpoints:**

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/ai-credits/balance` | Yes | Get credits balance, costs, pack info |
| POST | `/api/ai-credits/purchase` | Yes | Create Stripe checkout for credits purchase |
| GET | `/api/ai-credits/transactions` | Yes | Get credit transaction history |
| POST | `/api/ai-credits/fulfill` | Yes | Verify payment and grant credits |
| GET | `/api/ai-credits/config` | No | Get credits config (costs, packs, discount info) |

**Key rules:**
1. Only available to Pro plan subscribers
2. One-time payment, NOT a subscription
3. Credits are added to `user_quotas.ai_credits_balance`
4. Credits never expire and persist across billing cycles and cancellation
5. Idempotency: checks `ai_credit_transactions` table to prevent double-granting
6. Uses `price_data` with dynamic currency/amount (no Stripe Price object needed)
7. Balance endpoint returns costs, effective costs, and pack info

### Payment Method Management

- `POST /billing/update-payment-method` creates a Stripe checkout session in `mode: 'setup'` (no charge)
- User enters new card details in embedded checkout
- On completion, the new payment method is set as default on the Stripe customer
- `GET /billing/payment-method` returns last 4 digits, brand, expiry
- `DELETE /billing/delete-payment-method/:id` removes a saved method (cannot delete the default)

### Billing Cycle (Monthly vs Yearly)

- Billing cycle is set at subscription creation time and cannot be changed mid-subscription
- To switch cycles: cancel current subscription, wait for period end, resubscribe with new cycle
- `detectBillingCycle()` reads from Stripe subscription's base plan item interval
- Addon prices differ by cycle: monthly addons use monthly price IDs, yearly use yearly price IDs

---

## API Endpoints

### Primary Billing Endpoints (`/api/billing`)

| Method | Path | Auth | Rate Limit | Purpose |
|--------|------|------|------------|---------|
| POST | `/preview` | Yes | 10/min | Preview billing change cost |
| POST | `/change` | Yes | 5/min | Execute billing change |
| POST | `/verify-payment` | Yes | Global | Verify checkout payment & sync DB |
| POST | `/fulfill` | Yes | Global | Fulfill subscription (alternative to verify-payment) |
| POST | `/create-checkout-session` | Yes | Global | Create Stripe embedded checkout |
| POST | `/cancel-subscription` | Yes | Global | Cancel subscription |
| POST | `/downgrade-subscription` | Yes | Global | Cancel subscription (alias for cancel in new model) |
| POST | `/reactivate-subscription` | Yes | Global | Undo pending cancellation |
| POST | `/update-payment-method` | Yes | Global | Update saved payment method |
| POST | `/clear-checkout` | Yes | Global | Clear checkout state for retry |
| GET | `/subscription-status` | Yes | Global | Get current subscription state |
| GET | `/plans` | No | Global | Get available plans |
| GET | `/upcoming-invoice` | Yes | Global | Get next invoice preview |
| GET | `/payment-method` | Yes | Global | Get saved payment method(s) |
| GET | `/invoices` | Yes | Global | Get payment history (paid invoices from Stripe) |
| DELETE | `/delete-payment-method/:id` | Yes | Global | Delete payment method |

### Payment Receipts

plotwell generates its own payment receipts client-side instead of using Stripe's hosted invoice/receipt pages. This is because Stripe's documents are labeled as "invoices" which are **not tax-valid in Spain** (missing NIF, sequential numbering, IVA breakdown per Agencia Tributaria requirements).

**How it works:**
- `/invoices` endpoint lists **paid Stripe invoices** for the customer, including payment method details, customer name, and line item descriptions
- Frontend (`BillingHistoryPage.tsx`) generates a branded HTML receipt in a new window using `window.open()`
- Receipt includes: amount, date, payment method, customer name, description, transaction ID
- Receipt clearly states it is not a tax invoice
- Users requesting tax-compliant invoices are directed to `invoice@plotwell.co`
- User can print / save as PDF from the browser

### Pricing/Limits Endpoints (`/api/pricing`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/plans` | No | Get plan definitions |
| GET | `/subscription` | Yes | Get subscription + usage + limits |
| POST | `/check-limit` | Yes | Check if action is within limits |
| GET | `/usage` | Yes | Get usage analytics |
| GET | `/billing/history` | Yes | Get billing event history |

---

## Webhook Handling

### Design Philosophy

**Webhooks are a safety net, NOT the primary path.** The system should work correctly even if webhooks are delayed or missed. The primary paths are:

- **New subscription**: `/verify-payment` or `/fulfill` called by frontend after checkout
- **Addon changes**: `/change` endpoint handles everything synchronously
- **Cancellation**: `/change` with `type: 'cancel'` handles the initial cancel

### Webhook-Free Fallbacks

All critical subscription state changes have polling-based fallbacks that don't require webhooks:

| Scenario | Primary Path | Polling Fallback |
|----------|-------------|-----------------|
| New subscription | `/verify-payment` updates DB after checkout | `getSubscriptionStatus()` detects active sub in Stripe, updates DB |
| Period-end cancellation | Webhook `customer.subscription.deleted` | `getSubscriptionStatus()` sees no active sub in Stripe, downgrades DB to free |
| Expired + cancel_at_period_end | Webhook `customer.subscription.deleted` | `checkAndSyncStripeSubscription()` fast-path: if `cancel_at_period_end && now > periodEnd`, downgrades immediately (no Stripe API call) |
| Payment failure | Webhook `invoice.payment_failed` | `checkAndSyncStripeSubscription()` detects `past_due` status from Stripe |
| Addon changes | `/change` endpoint syncs directly | `getSubscriptionStatus()` reads addon items from Stripe |

The frontend polls `/api/user/subscription` every 30 seconds, which triggers both `checkAndSyncStripeSubscription()` (pricingService) and `getSubscriptionStatus()` (stripeService). Between these two, any Stripe state change will be detected within ~30 seconds even if all webhooks fail.

### Where Webhooks Are Safety Nets

All webhook events are safety nets. The system works without them, but webhooks provide faster state updates:

| Event | Primary Path | Webhook Backup |
|-------|-------------|---------------|
| `checkout.session.completed` | `/verify-payment` or `/fulfill` | Grants credits, updates plan |
| `customer.subscription.created` | `/verify-payment` or `/fulfill` | Updates plan_id, sends welcome email |
| `customer.subscription.updated` | `/change` endpoint | Syncs addon quantities |
| `customer.subscription.deleted` | Polling fallback in `getSubscriptionStatus()` | Immediate downgrade, sends cancellation email |
| `invoice.payment_failed` | Polling fallback in `checkAndSyncStripeSubscription()` | Immediate status update, sends payment failed email |
| `invoice.payment_succeeded` | N/A (informational) | Logs payment, sends renewal email |

### Webhook Events Handled

| Event | Handler | Action |
|-------|---------|--------|
| `customer.created` | `handleCustomerCreated` | Store stripe_customer_id |
| `customer.subscription.created` | `handleCustomerSubscriptionCreated` | Update plan_id + status |
| `customer.subscription.updated` | `handleCustomerSubscriptionUpdated` | Update plan + addons |
| `customer.subscription.deleted` | `handleCustomerSubscriptionDeleted` | Downgrade to free |
| `invoice.payment_succeeded` | `handleInvoicePaymentSucceeded` | Log payment |
| `invoice.payment_failed` | `handleInvoicePaymentFailed` | Set status past_due |
| `checkout.session.completed` | `handleCheckoutSessionCompleted` | Backup plan update + launch credits + AI credits fulfillment |
| `invoiceitem.created` | `handleInvoiceItemCreated` | Monitors proration items (no manual intervention) |
| `charge.dispute.created` | `handleChargeDisputeCreated` | Placeholder |
| `refund.created` | `handleRefundCreated` | Placeholder |

---

## Frontend Integration

### State Management

- `SubscriptionContext` polls `/api/user/subscription` every 30 seconds
- `useBilling()` hook manages billing modal state and operations
- `useAddonManagement()` hook manages addon changes

### Post-Payment Flow

After Stripe checkout completes, the frontend:
1. Redirects to `/projects?subscription_success=true&session_id=...`
2. Calls `POST /api/billing/verify-payment` with the session ID
3. Retries subscription fetch up to 5 times (1500ms apart) until plan updates
4. Navigates to `/projects?view=usage`

### Checkout Session Lifecycle

- 5-minute timeout on embedded checkout
- Singleton pattern prevents multiple checkout instances
- `/clear-checkout` endpoint resets state for retry after failure/abandonment

---

## Proration Logic

### Addon Addition (Mid-Cycle)

```
prorated_charge = (full_period_addon_cost * days_remaining) / total_days_in_period
```

- Prorated amount charged immediately via one-off invoice
- Recurring subscription item added for future billing cycles

### Addon Removal (Mid-Cycle)

- **No refund** for either monthly or yearly. The user paid for the current period and keeps access until it ends. The addon is simply removed from recurring billing so it won't charge on the next cycle.

### Calculation Source

- `billing_cycle_anchor` from Stripe is the authoritative period start
- Days are calculated using full calendar days (not hours)
- Rounding: customer-friendly (charges rounded down)

---

## Security

### Payment Verification

- `/verify-payment` validates that the checkout session belongs to the authenticated user (`session.metadata.user_id === userId`)
- `metadata.user_id` is set server-side in `createCheckoutSession()`, not from client input
- Idempotency: billing events table prevents duplicate verification

### Subscription Updates

- All database updates include user ownership checks
- `cancel_at_period_end` is used instead of immediate cancellation (preserves access)
- Plan is never upgraded before payment confirmation

### Rate Limiting

- Preview: 10 requests/minute
- Changes: 5 requests/minute
- All other endpoints: 10 requests/minute (global billing limiter)
- Cooldown: 10-second cooldown between actual billing modifications

### Duplicate Prevention

- `cancelDuplicateSubscriptions()` runs before every new checkout
- `expireIncompleteCheckoutSessions()` prevents multiple embedded checkouts
- Database-backed idempotency via `operationLockService` (60-second window) for addon change operations
- Checkout session creation (`type: 'new'`) is NOT cached because Stripe sessions can only be used once

---

## Common Gotchas

1. **`items.data[0]` is NOT always the base plan.** Stripe subscription items have no guaranteed order. When a subscription has addons, the first item could be an addon. Always iterate all items to find the base plan price via `getPlanIdFromStripePrice()`.

2. **`getPlanIdFromStripePrice()` only maps base plan prices.** It returns `null` for addon price IDs. If you use the result as a fallback (`|| 'free'`), an addon price will incorrectly map to `'free'`.

3. **`user_subscriptions.status` can be `'incomplete'` or `'trialing'`** during checkout or free trial. Queries that filter `.eq('status', 'active')` will miss the record, causing fallback to free plan behavior. Use `.maybeSingle()` without status filter when you need the actual DB state. Both `'active'` and `'trialing'` are treated as valid paid states.

4. **Stripe customer ID survives cancellation.** When a user cancels and resubscribes, the same `stripe_customer_id` is reused. `cancelDuplicateSubscriptions()` cleans up old subs before creating new ones.

5. **Two sync mechanisms exist.** `checkAndSyncStripeSubscription()` (pricingService) and `getSubscriptionStatus()` (stripeService) both sync DB with Stripe but via different paths. Both are triggered by frontend polling. Don't add a third.

6. **Addons are never refunded.** When removing addons, the recurring subscription item is removed but no credit or refund is issued. The user already paid for the current period.

7. **`cancel_at_period_end` keeps the user on paid.** The plan stays `'paid'` until the period actually ends. During this grace period, the user has full access but cannot add new addons.

---

## Known Limitations & Future Improvements

### Current Limitations

1. **Billing cycle switching**: Users cannot switch monthly <-> yearly mid-subscription. Must cancel and resubscribe.

### Planned Improvements

1. **Consolidate subscription getters**: Single `getCurrentSubscription()` used everywhere
2. **Retire legacy pricing.ts endpoints**: Move remaining used endpoints to unified billing

### Recent Improvements

1. **Database-backed operation locks**: Billing operations now use `operationLockService.ts` with the `operation_locks` table for idempotency and deduplication. Locks survive server restarts (TTL-based cleanup every 5 minutes).
2. **Simplified to single currency (USD)**: Previously multi-currency (EUR, USD, GBP). Now USD only; Stripe handles conversion and deposits in EUR to Spanish bank account.
3. **Free trial for yearly plans**: 14-day free trial offered to new users (never previously subscribed) selecting the yearly billing cycle. Trial eligibility checked against both DB (`user_subscriptions.status === 'cancelled'`) and Stripe subscription history.
4. **Transactional emails**: Welcome, renewal, cancellation, payment failed, and credits confirmation emails sent via `emailService` (fire-and-forget).
5. **Agent writer feature**: New `agentWriter` boolean limit on plans (Pro only). Checked via `requireFeature('agent_writer')` middleware.

---

## Environment Variables

```bash
# Stripe API
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Plan price IDs (from Stripe Dashboard)
STRIPE_PAID_MONTHLY_PRICE_ID=price_...
STRIPE_PAID_YEARLY_PRICE_ID=price_...

# Addon price IDs (monthly and yearly variants)
STRIPE_ADDON_PROJECT_PRICE_ID=price_...
STRIPE_ADDON_COLLABORATOR_PRICE_ID=price_...
STRIPE_ADDON_PROJECT_YEARLY_PRICE_ID=price_...
STRIPE_ADDON_COLLABORATOR_YEARLY_PRICE_ID=price_...

# AI Credits (optional - credits use price_data, not a fixed Stripe Price)
STRIPE_AI_CREDITS_PRICE_ID=price_...
```

All price IDs must match the prices configured in the Stripe Dashboard for the corresponding environment (test vs live).

---

## Currency

### Single Currency: USD

The system uses **USD only**. The `currencies.ts` config always returns USD regardless of request origin. Stripe handles currency conversion and deposits in EUR to the Spanish bank account.

- **Config**: `src/config/currencies.ts` - pricing table (USD only), `detectCurrencyFromRequest()` always returns `'USD'`
- **API**: `GET /api/pricing/plans` returns `{ plans, currency: 'USD', currency_symbol: '$', prices }`
- **AI Credits**: Use `price_data` with USD amount (no `currency_options` needed)
- **BillingPreview** responses include `currency` in `cost_breakdown`

### Price Table (USD)

| Item | Monthly | Yearly |
|------|---------|--------|
| Pro plan | $5 | $50 |
| Additional project | $3 | $30 |
| Additional collaborator | $3 | $30 |
| AI Credits (small) | $5 (one-time) | - |
| AI Credits (large) | $10 (one-time) | - |
| AI Credits (bulk) | $20 (one-time) | - |
