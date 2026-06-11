/**
 * Canonical subscription helpers.
 *
 * These are the ONLY functions the codebase should use to answer:
 *   - "Is this user on a paid plan?"   → isPaidSubscription()
 *   - "Is this status active?"         → isActiveStatus()
 *   - "Get the subscription record"    → getSubscriptionRecord()
 *
 * Do NOT inline plan_id / status checks elsewhere.
 */

// ── Pure helpers (no DB) ────────────────────────────────────────

/** Active statuses that grant paid-plan access */
const ACTIVE_STATUSES = ['active', 'trialing'] as const;

/** Is this status one that grants access? */
export function isActiveStatus(status: string | undefined | null): boolean {
  return ACTIVE_STATUSES.includes((status || '') as any);
}

/** Does this subscription record represent a paid, active user? */
export function isPaidSubscription(sub: { plan_id?: string; status?: string; subscription_status?: string } | null | undefined): boolean {
  if (!sub) return false;
  const status = sub.status || sub.subscription_status;
  return sub.plan_id === 'paid' && isActiveStatus(status);
}

// ── Database accessor ───────────────────────────────────────────

export interface SubscriptionRecord {
  plan_id: string;
  status: string;
  additional_projects: number;
  additional_collaborators: number;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  current_period_start: string | null;
  stripe_subscription_id: string | null;
  plan_price: number | null;
  plan_currency: string;
}

const DEFAULT_RECORD: SubscriptionRecord = {
  plan_id: 'free',
  status: 'active',
  additional_projects: 0,
  additional_collaborators: 0,
  cancel_at_period_end: false,
  current_period_end: null,
  current_period_start: null,
  stripe_subscription_id: null,
  plan_price: null,
  plan_currency: 'usd',
};

/**
 * Single canonical query for a user's subscription.
 * All backend code that needs subscription data should call this.
 */
export async function getSubscriptionRecord(
  supabase: any,
  userId: string
): Promise<SubscriptionRecord> {
  const { data } = await supabase
    .from('user_subscriptions')
    .select('plan_id, status, additional_projects, additional_collaborators, cancel_at_period_end, current_period_end, current_period_start, stripe_subscription_id, plan_price, plan_currency')
    .eq('user_id', userId)
    .in('status', ACTIVE_STATUSES)
    .maybeSingle();

  if (!data) return { ...DEFAULT_RECORD };

  return {
    plan_id: data.plan_id || 'free',
    status: data.status || 'active',
    additional_projects: data.additional_projects || 0,
    additional_collaborators: data.additional_collaborators || 0,
    cancel_at_period_end: data.cancel_at_period_end || false,
    current_period_end: data.current_period_end || null,
    current_period_start: data.current_period_start || null,
    stripe_subscription_id: data.stripe_subscription_id || null,
    plan_price: data.plan_price || null,
    plan_currency: data.plan_currency || 'usd',
  };
}
