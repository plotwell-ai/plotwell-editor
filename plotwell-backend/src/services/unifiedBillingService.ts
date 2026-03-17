import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { stripeService } from './stripeService';
import { getPlanById, getStripePriceId, getAddonStripePriceId, currentPriceIds, PRICING_PLANS, getAddonPriceId, getAddonPriceForPlan } from '../config/pricingPlans';
import { getCurrentTime, getCurrentDate, getDaysUntil, addTimeToNow, addOneMonth, calculateBillingPeriodEnd, isSimulationMode } from '../utils/timeUtils';
import { acquireLock, releaseLock } from './operationLockService';
import { getPricesForCurrency, getCurrencyConfig, type CurrencyCode, type CurrencyPriceTable } from '../config/currencies';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-08-27.basil',
});

// TypeScript interfaces for billing operations
export interface BillingChangeRequest {
  type: 'new' | 'cancel' | 'addon_change'; // SIMPLIFIED: No more upgrade/downgrade between paid tiers
  target_plan?: string; // Only 'free' or 'paid' now (legacy: 'pro', 'teams', 'business' for migration)
  billing_cycle?: 'monthly' | 'yearly';
  addons?: {
    additional_projects?: number;
    additional_collaborators?: number;
    // Note: AI credits are now one-time purchases via /api/ai-credits/purchase
  };
  immediate_cancellation?: boolean;
  currency?: string; // e.g. 'eur', 'usd', 'gbp' - detected from user's location or Stripe customer
}

export interface BillingPreview {
  type: 'new_subscription' | 'subscription_change' | 'cancellation';
  billing_cycle?: 'monthly' | 'yearly';
  current_plan?: string;
  target_plan?: string;
  cost_breakdown: {
    base_plan_cost: number; // cents
    addon_costs: number; // cents
    total_immediate_charge: number; // cents (can be negative for refunds)
    next_billing_amount: number; // cents
    next_billing_date?: string; // ISO date string
    currency: string;
    // Itemized breakdown for transparency
    items?: Array<{
      type: 'base' | 'addon';
      name: string;
      quantity?: number;
      unit_price: number; // cents
      total_price: number; // cents
    }>;
  };
  proration_details?: {
    days_remaining: number;
    estimated_credit: number; // cents
    estimated_cost: number; // cents
  };
  summary: string; // Human readable description

  // Cancellation validation fields
  blocked?: boolean; // If true, cancellation is blocked due to usage limits
  validation_errors?: Array<{ code: string; params: Record<string, number> }>; // Structured error codes with translation parameters
  current_usage?: {
    projects: number;
    collaborators: number;
  };
  cleanup_required?: {
    projectsToDelete: number;
    collaboratorsToRemove: number;
    collaboratorCleanupOptions?: string[];
  };
}

export interface SubscriptionState {
  plan_id: string;
  subscription_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  additional_projects: number;
  additional_collaborators: number;
  billing_cycle: 'monthly' | 'yearly';
  // Note: AI credits are now one-time purchases via /api/ai-credits/purchase (not subscription addons)
}

// Billing cycle calculation utilities
interface BillingCycleInfo {
  daysLeft: number;
  totalDays: number;
  periodStart: Date;
  periodEnd: Date;
  progressRatio: number; // 0-1, how far through the billing cycle we are
}

function calculateBillingCycleInfo(subscription: Stripe.Subscription): BillingCycleInfo {
  const now = new Date();

  // Handle missing timestamps with fallbacks
  let periodStartTimestamp = (subscription as any).current_period_start;
  let periodEndTimestamp = (subscription as any).current_period_end;

  // If timestamps are missing, create fallback billing cycle (30 days from now)
  if (!periodStartTimestamp || !periodEndTimestamp) {
    periodStartTimestamp = Math.floor(now.getTime() / 1000);
    periodEndTimestamp = Math.floor((now.getTime() + (30 * 24 * 60 * 60 * 1000)) / 1000);
  }

  const periodStart = new Date(periodStartTimestamp * 1000);
  const periodEnd = new Date(periodEndTimestamp * 1000);

  const totalDays = Math.ceil((periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24));
  const daysLeft = Math.ceil((periodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const progressRatio = Math.max(0, Math.min(1, (now.getTime() - periodStart.getTime()) / (periodEnd.getTime() - periodStart.getTime())));

  return {
    daysLeft: Math.max(0, daysLeft),
    totalDays: Math.max(1, totalDays), // Ensure never 0 to avoid division by zero
    periodStart,
    periodEnd,
    progressRatio
  };
}

function calculateProratedCharge(fullMonthlyPrice: number, billingCycle: BillingCycleInfo): number {
  // Calculate prorated charge for the remaining days in the current billing period
  const proratedAmount = (fullMonthlyPrice * billingCycle.daysLeft) / billingCycle.totalDays;
  return Math.max(0, proratedAmount);
}

export class UnifiedBillingService {

  private readonly MODIFICATION_COOLDOWN_SECONDS = 10;

  /**
   * Get currency-aware prices for a billing request.
   * Returns plan price and addon price based on the request's currency.
   */
  private getCurrencyPrices(request: BillingChangeRequest, billingCycle: 'monthly' | 'yearly' = 'monthly') {
    const currency = (request.currency || 'eur').toUpperCase() as CurrencyCode;
    const prices = getPricesForCurrency(currency);
    const config = getCurrencyConfig(currency);
    return {
      planPrice: billingCycle === 'yearly' ? prices.pro_yearly : prices.pro_monthly,
      addonProjectPrice: billingCycle === 'yearly' ? prices.addon_project_yearly : prices.addon_project_monthly,
      addonCollaboratorPrice: billingCycle === 'yearly' ? prices.addon_collaborator_yearly : prices.addon_collaborator_monthly,
      currency: config.stripeCurrency,
      currencySymbol: config.symbol,
      prices,
    };
  }

  private async isRecentModification(userId: string): Promise<boolean> {
    // acquireLock returns false if lock already exists (= recent modification)
    const acquired = await acquireLock('billing_cooldown', userId, this.MODIFICATION_COOLDOWN_SECONDS);
    if (acquired) {
      // We acquired it, but we only wanted to check — release immediately
      // Actually, keep it: it serves as the cooldown marker
      return false;
    }
    return true;
  }

  private async recordModification(userId: string): Promise<void> {
    // acquireLock creates or refreshes the lock with TTL
    await acquireLock('billing_cooldown', userId, this.MODIFICATION_COOLDOWN_SECONDS);
  }

  /**
   * Round charges up to next 50 cents, credits down to previous 50 cents
   */
  private roundCustomerFriendly(amount: number, isCredit: boolean): number {
    const euros = Math.floor(Math.abs(amount));
    const cents = Math.abs(amount) - euros;

    let roundedAmount: number;
    if (isCredit) {
      // Credits: round DOWN (customer gets slightly less refund but conservative)
      if (cents <= 0.5) {
        roundedAmount = euros + (cents > 0.25 ? 0.5 : 0);
      } else {
        roundedAmount = euros + 0.5;
      }
    } else {
      // Charges: round UP (customer pays slightly more but gets nice round number)
      if (cents <= 0.25) {
        roundedAmount = euros + (cents > 0 ? 0.5 : 0);
      } else if (cents <= 0.75) {
        roundedAmount = euros + 0.5;
      } else {
        roundedAmount = euros + 1;
      }
    }

    return amount < 0 ? -roundedAmount : roundedAmount;
  }

  /**
   * Get current subscription state for a user
   */
  async getCurrentSubscription(userId: string): Promise<SubscriptionState> {
    try {

      // Get user's Stripe info
      const stripeStatus = await stripeService.getSubscriptionStatus(userId);

      // Get addon info from database - get ONLY the active subscription
      const { data: userSubscription } = await supabase
        .from('user_subscriptions')
        .select('additional_projects, additional_collaborators, status')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(); // Use maybeSingle() to handle 0 or 1 results gracefully

      // Detect billing cycle from Stripe subscription
      let billingCycle: 'monthly' | 'yearly' = 'monthly';
      if (stripeStatus.stripe_subscription_id) {
        billingCycle = await this.detectBillingCycle(stripeStatus.stripe_subscription_id);
      }

      const state: SubscriptionState = {
        plan_id: stripeStatus.plan_id || 'free',
        subscription_status: stripeStatus.subscription_status || 'active',
        stripe_customer_id: stripeStatus.stripe_customer_id || null,
        stripe_subscription_id: stripeStatus.stripe_subscription_id || null,
        current_period_start: stripeStatus.current_period_start || null,
        current_period_end: stripeStatus.current_period_end || null,
        cancel_at_period_end: stripeStatus.cancel_at_period_end || false,
        additional_projects: userSubscription?.additional_projects || 0,
        additional_collaborators: userSubscription?.additional_collaborators || 0,
        billing_cycle: billingCycle
      };


      return state;
    } catch (error) {
      console.error(`❌ Error getting current subscription for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Preview billing change with exact Stripe calculations
   */
  async previewBillingChange(userId: string, request: BillingChangeRequest): Promise<BillingPreview> {
    try {

      const currentState = await this.getCurrentSubscription(userId);
      const currentPlan = getPlanById(currentState.plan_id);

      if (!currentPlan) {
        throw new Error(`Current plan not found: ${currentState.plan_id}`);
      }

      switch (request.type) {
        case 'new':
          // SIMPLIFIED: Only free → paid subscription creation
          return await this.previewNewSubscription(currentState, request);

        case 'addon_change':
          // MAIN OPERATION: Adding/removing projects and collaborators
          return await this.previewAddonChange(userId, currentState, request);

        case 'cancel':
          // SIMPLIFIED: Only paid → free cancellation
          return await this.previewCancellation(currentState, userId);

        default:
          throw new Error(`Invalid billing change type: ${request.type}. New model only supports: new, addon_change, cancel`);
      }
    } catch (error) {
      console.error(`❌ Error creating billing preview:`, error);
      throw error;
    }
  }

  /**
   * Clear the cooldown for a user (used when user cancels checkout and wants to retry)
   */
  async clearCooldown(userId: string): Promise<void> {
    await releaseLock('billing_cooldown', userId);
  }

  /**
   * Execute billing change atomically
   */
  async executeBillingChange(userId: string, request: BillingChangeRequest): Promise<{ success: boolean; message: string; details?: any }> {
    try {
      // For 'new' subscription (checkout session creation), use a shorter cooldown
      // since we're just creating a session, not completing a payment
      const isNewSubscription = request.type === 'new';

      // Only apply strict cooldown for actual billing changes (addon_change, cancel)
      // For 'new', we just check for very rapid duplicate clicks (2 seconds)
      if (!isNewSubscription && await this.isRecentModification(userId)) {
        return {
          success: false,
          message: 'Please wait a moment before making another billing change',
          details: { reason: 'too_frequent', cooldown_seconds: this.MODIFICATION_COOLDOWN_SECONDS }
        };
      }

      const currentState = await this.getCurrentSubscription(userId);

      // Clean up any duplicate subscriptions first
      if (currentState.stripe_customer_id) {
        await stripeService.cancelDuplicateSubscriptions(currentState.stripe_customer_id);
      }

      let result: { success: boolean; message: string; details?: any };

      switch (request.type) {
        case 'new':
          // SIMPLIFIED: Only free → paid subscription creation
          result = await this.executeNewSubscription(userId, currentState, request);
          break;

        case 'addon_change':
          // MAIN OPERATION: Adding/removing projects and collaborators at €4 each
          result = await this.executeAddonChange(userId, currentState, request);
          break;

        case 'cancel':
          // SIMPLIFIED: Only paid → free cancellation
          result = await this.executeCancellation(userId, currentState, request);
          break;

        default:
          throw new Error(`Invalid billing change type: ${request.type}. New model only supports: new, addon_change, cancel`);
      }

      // Only record cooldown AFTER successful operations (not checkout session creation)
      if (result.success && !isNewSubscription) {
        await this.recordModification(userId);
      }

      return result;
    } catch (error) {
      console.error(`❌ Error executing billing change:`, error);
      throw error;
    }
  }

  // Private methods for previewing changes

  private async previewNewSubscription(currentState: SubscriptionState, request: BillingChangeRequest): Promise<BillingPreview> {
    if (!request.target_plan) {
      throw new Error('Target plan required for new subscription');
    }

    const targetPlan = getPlanById(request.target_plan);
    if (!targetPlan) {
      throw new Error(`Target plan not found: ${request.target_plan}`);
    }

    const billingCycle = request.billing_cycle || 'monthly';

    // Use currency-aware prices if currency is provided
    const currencyPrices = this.getCurrencyPrices(request, billingCycle);
    const planPrice = targetPlan.id === 'free' ? 0 : currencyPrices.planPrice;

    // Calculate addon costs using the correct billing cycle pricing
    const addons = request.addons || {};
    const addonUnitPrice = currencyPrices.addonProjectPrice;
    const addonTotal = ((addons.additional_projects || 0) + (addons.additional_collaborators || 0)) * addonUnitPrice;
    const addonUnitPriceCents = Math.round(addonUnitPrice * 100);

    const totalCost = Number(planPrice) + Number(addonTotal);
    const nextBillingDate = addTimeToNow((billingCycle === 'yearly' ? 365 : 30) * 24 * 60 * 60 * 1000);

    // Ensure we have valid prices (prevent NaN in UI)
    const safePlanPrice = Number(planPrice) || 0;
    const safeAddonTotal = Number(addonTotal) || 0;
    const safeTotalCost = Number(totalCost) || 0;

    // Build itemized breakdown
    const items: Array<{type: 'base' | 'addon'; name: string; quantity?: number; unit_price: number; total_price: number}> = [];

    // Add base plan
    items.push({
      type: 'base',
      name: `${targetPlan.name} (${billingCycle})`,
      unit_price: Math.round(safePlanPrice * 100),
      total_price: Math.round(safePlanPrice * 100)
    });

    // Add addons if any
    if (addons.additional_projects && addons.additional_projects > 0) {
      items.push({
        type: 'addon',
        name: 'Additional Projects',
        quantity: addons.additional_projects,
        unit_price: addonUnitPriceCents,
        total_price: addonUnitPriceCents * addons.additional_projects
      });
    }

    if (addons.additional_collaborators && addons.additional_collaborators > 0) {
      items.push({
        type: 'addon',
        name: 'Additional Collaborators',
        quantity: addons.additional_collaborators,
        unit_price: addonUnitPriceCents,
        total_price: addonUnitPriceCents * addons.additional_collaborators
      });
    }

    return {
      type: 'new_subscription',
      billing_cycle: billingCycle,
      target_plan: request.target_plan,
      cost_breakdown: {
        base_plan_cost: Math.round(safePlanPrice * 100), // cents
        addon_costs: Math.round(safeAddonTotal * 100), // cents
        total_immediate_charge: Math.round(safeTotalCost * 100), // cents
        next_billing_amount: Math.round(safeTotalCost * 100), // cents
        next_billing_date: nextBillingDate.toISOString(),
        currency: currencyPrices.currency,
        items
      },
      summary: `Start ${targetPlan.name} plan (${billingCycle}) for ${currencyPrices.currencySymbol}${safeTotalCost.toFixed(2)}${billingCycle === 'yearly' ? '/year' : '/month'}${safeAddonTotal > 0 ? ' including addons' : ''}. Billing cycle starts today.`
    };
  }

  private async previewPlanChange(currentState: SubscriptionState, request: BillingChangeRequest): Promise<BillingPreview> {
    if (!request.target_plan) {
      throw new Error('Target plan required for plan change');
    }

    if (!currentState.stripe_subscription_id) {
      throw new Error('No active subscription found');
    }

    const currentPlan = getPlanById(currentState.plan_id);
    const targetPlan = getPlanById(request.target_plan);

    if (!currentPlan || !targetPlan) {
      throw new Error('Plan not found');
    }

    // Handle free plan downgrade separately (no Stripe price ID needed)
    if (request.target_plan === 'free') {
      return await this.previewDowngradeToFree(currentState, currentPlan);
    }

    // Use Stripe's upcoming invoice API for accurate preview
    const targetPriceId = getStripePriceId(request.target_plan, 'monthly');
    if (!targetPriceId) {
      throw new Error(`Stripe price ID not found for plan ${request.target_plan}`);
    }

    try {
      // First get subscription item ID
      const currentSubscription = await stripe.subscriptions.retrieve(currentState.stripe_subscription_id, {
        expand: ['items.data.price', 'latest_invoice']
      });
      const subscriptionItemId = currentSubscription.items.data[0].id;

      // Get the upcoming invoice preview from Stripe
      const upcomingInvoice = await stripe.invoices.list({
        customer: currentState.stripe_customer_id!,
        subscription: currentState.stripe_subscription_id,
        limit: 1,
        status: 'draft'
      });

      // Calculate proration manually for accurate preview
      const { proration, billingDates } = await this.calculateProration(currentSubscription, currentPlan, targetPlan);
      const immediateCharge = Math.round(proration.netCharge * 100); // convert to cents
      const nextBillingAmount = Math.round(targetPlan.price * 100); // cents

      // Detect billing cycle to use correct addon pricing
      const detectedBillingCycle = await this.detectBillingCycle(currentState.stripe_subscription_id);

      // Handle addons with compatibility filtering
      const currentAddonCosts = this.calculateCurrentAddonCosts(currentState.plan_id, currentState, detectedBillingCycle);
      const newAddons = this.mergeAndFilterAddons(currentState, request.target_plan, request.addons);
      const newAddonCosts = this.calculateAddonCosts(request.target_plan, newAddons, detectedBillingCycle);
      const addonUnitPriceCents = this.getAddonUnitPriceCents(detectedBillingCycle);

      const changeType = request.target_plan === 'free' ? 'cancellation' : 'subscription_change';

      // Get period info using actual subscription dates with fallback
      const periodEndTimestamp = (currentSubscription as any).current_period_end;
      const periodStartTimestamp = (currentSubscription as any).current_period_start;

      let daysRemaining = 0;

      if (periodEndTimestamp && periodStartTimestamp) {
        const currentPeriodEnd = new Date(periodEndTimestamp * 1000);
        const currentPeriodStart = new Date(periodStartTimestamp * 1000);
        const now = getCurrentDate();

        const totalDays = Math.ceil((currentPeriodEnd.getTime() - currentPeriodStart.getTime()) / (1000 * 60 * 60 * 24));
        const elapsedDays = Math.ceil((now.getTime() - currentPeriodStart.getTime()) / (1000 * 60 * 60 * 24));
        daysRemaining = Math.max(0, totalDays - elapsedDays + 1); // +1 to include current day
      } else if (periodEndTimestamp) {
        // Fallback: use subscription creation date if period start is missing
        const currentPeriodEnd = new Date(periodEndTimestamp * 1000);
        const subscriptionCreated = new Date(currentSubscription.created * 1000);
        const now = getCurrentDate();

        const totalDays = Math.ceil((currentPeriodEnd.getTime() - subscriptionCreated.getTime()) / (1000 * 60 * 60 * 24));
        const elapsedDays = Math.ceil((now.getTime() - subscriptionCreated.getTime()) / (1000 * 60 * 60 * 24));
        daysRemaining = Math.max(0, totalDays - elapsedDays + 1); // +1 to include current day
      } else {
        // Ultimate fallback: calculate actual month cycle from creation
        const subscriptionCreated = new Date(currentSubscription.created * 1000);
        const now = getCurrentDate();

        // Find which billing period we're currently in
        let currentPeriodStart = new Date(subscriptionCreated);
        let currentPeriodEnd = calculateBillingPeriodEnd(currentPeriodStart);

        // If we're past the first period, find the current one
        while (now.getTime() >= currentPeriodEnd.getTime()) {
          currentPeriodStart = new Date(currentPeriodEnd);
          currentPeriodEnd = calculateBillingPeriodEnd(currentPeriodStart);
        }

        const totalDays = Math.ceil((currentPeriodEnd.getTime() - currentPeriodStart.getTime()) / (1000 * 60 * 60 * 24));
        const elapsedDays = Math.ceil((now.getTime() - currentPeriodStart.getTime()) / (1000 * 60 * 60 * 24));
        daysRemaining = Math.max(0, totalDays - elapsedDays + 1); // +1 to include current day

      }

      // Ensure we have valid prices (prevent NaN in UI)
      const safeTargetPrice = Number(targetPlan.price) || 0;
      const safeAddonTotal = Number(newAddonCosts.total) || 0;
      const safeCurrentAddonTotal = Number(currentAddonCosts.total) || 0;
      const safeImmediateCharge = Number(immediateCharge) || 0;

      // Build itemized breakdown
      const items: Array<{type: 'base' | 'addon'; name: string; quantity?: number; unit_price: number; total_price: number}> = [];

      // Add base plan
      items.push({
        type: 'base',
        name: `${targetPlan.name} (${detectedBillingCycle})`,
        unit_price: Math.round(safeTargetPrice * 100),
        total_price: Math.round(safeTargetPrice * 100)
      });

      // Add addons if any
      if (newAddons.additional_projects && newAddons.additional_projects > 0) {
        items.push({
          type: 'addon',
          name: 'Additional Projects',
          quantity: newAddons.additional_projects,
          unit_price: addonUnitPriceCents,
          total_price: addonUnitPriceCents * newAddons.additional_projects
        });
      }

      if (newAddons.additional_collaborators && newAddons.additional_collaborators > 0) {
        items.push({
          type: 'addon',
          name: 'Additional Collaborators',
          quantity: newAddons.additional_collaborators,
          unit_price: addonUnitPriceCents,
          total_price: addonUnitPriceCents * newAddons.additional_collaborators
        });
      }

      return {
        type: changeType,
        current_plan: currentState.plan_id,
        target_plan: request.target_plan,
        cost_breakdown: {
          base_plan_cost: Math.round(safeTargetPrice * 100), // cents
          addon_costs: Math.round(safeAddonTotal * 100), // cents
          total_immediate_charge: Math.round(this.roundCustomerFriendly((safeImmediateCharge / 100) + (safeAddonTotal - safeCurrentAddonTotal), safeImmediateCharge < 0) * 100), // cents
          next_billing_amount: request.target_plan === 'free' ? 0 : Math.round((safeTargetPrice + safeAddonTotal) * 100), // cents
          next_billing_date: billingDates.next_billing_date,
          currency: 'eur',
          items
        },
        proration_details: daysRemaining > 0 ? {
          days_remaining: daysRemaining,
          estimated_credit: Math.round(this.roundCustomerFriendly(Math.abs(Math.min(0, proration.credit)), true) * 100), // cents (positive value)
          estimated_cost: Math.round(this.roundCustomerFriendly(Math.max(0, immediateCharge / 100), false) * 100) // cents
        } : undefined,
        summary: this.generateStripePoweredSummary(changeType, currentPlan, targetPlan, Math.round(this.roundCustomerFriendly((safeImmediateCharge / 100) + (safeAddonTotal - safeCurrentAddonTotal), safeImmediateCharge < 0) * 100) / 100, billingDates.current_period_end, targetPlan.price < currentPlan.price)
      };

    } catch (stripeError: any) {
      console.error('❌ Stripe upcoming invoice error:', stripeError);
      // Fallback to manual calculation if Stripe preview fails
      return this.fallbackManualPreview(currentState, request, currentPlan, targetPlan);
    }
  }

  private async previewAddonChange(userId: string, currentState: SubscriptionState, request: BillingChangeRequest): Promise<BillingPreview> {
    if (!currentState.stripe_subscription_id) {
      throw new Error('Active subscription required for addon changes');
    }

    // Block addon additions if subscription is set to cancel
    if (currentState.cancel_at_period_end) {
      const hasNewAddons = (request.addons?.additional_projects ?? 0) > (currentState.additional_projects || 0) ||
        (request.addons?.additional_collaborators ?? 0) > (currentState.additional_collaborators || 0);
      if (hasNewAddons) {
        return {
          type: 'subscription_change',
          billing_cycle: await this.detectBillingCycle(currentState.stripe_subscription_id),
          current_plan: currentState.plan_id,
          target_plan: currentState.plan_id,
          cost_breakdown: {
            base_plan_cost: 0,
            addon_costs: 0,
            total_immediate_charge: 0,
            next_billing_amount: 0,
            currency: 'eur'
          },
          blocked: true,
          validation_errors: [{ code: 'subscription_cancelling', params: {} }],
          summary: 'Cannot add addons: Your subscription is set to cancel. Reactivate your subscription first.'
        };
      }
    }

    const currentPlan = getPlanById(currentState.plan_id);
    if (!currentPlan) {
      throw new Error(`Current plan not found: ${currentState.plan_id}`);
    }

    // Detect billing cycle to use correct addon pricing
    const billingCycle = await this.detectBillingCycle(currentState.stripe_subscription_id);
    const billingLabel = billingCycle === 'yearly' ? 'year' : 'month';

    const currentAddonCosts = this.calculateCurrentAddonCosts(currentState.plan_id, currentState, billingCycle);
    const newAddons = this.mergeAddons(currentState, request.addons);
    const newAddonCosts = this.calculateAddonCosts(currentState.plan_id, newAddons, billingCycle);

    // CRITICAL: Validate that reducing addons won't exceed new effective limits
    const addonValidation = await this.validateAddonChangeEligibility(userId, currentState, newAddons);
    if (!addonValidation.canChange) {
      // Return blocking preview with validation errors
      return {
        type: 'subscription_change',
        billing_cycle: billingCycle,
        current_plan: currentState.plan_id,
        target_plan: currentState.plan_id,
        cost_breakdown: {
          base_plan_cost: Math.round((currentPlan.price || 0) * 100),
          addon_costs: Math.round(newAddonCosts.total * 100),
          total_immediate_charge: 0,
          next_billing_amount: 0,
          currency: 'eur'
        },
        summary: `Cannot reduce addons: You must reduce usage to fit within the new limits first`,
        validation_errors: addonValidation.blockers,
        current_usage: addonValidation.currentUsage,
        blocked: true
      };
    }

    const subscription = await stripe.subscriptions.retrieve(currentState.stripe_subscription_id);
    const currentPeriodEnd = this.getSubscriptionPeriodEnd(subscription);

    // Use the correct base plan price for the billing cycle
    const basePlanPrice = billingCycle === 'yearly' ? (currentPlan.yearlyPrice || 0) : (currentPlan.price || 0);

    // Ensure we have valid prices (prevent NaN in UI)
    const safeCurrentPrice = Number(basePlanPrice) || 0;
    const safeCurrentAddonTotal = Number(currentAddonCosts.total) || 0;
    const safeNewAddonTotal = Number(newAddonCosts.total) || 0;

    const addonCostDifference = safeNewAddonTotal - safeCurrentAddonTotal;
    const totalNewCost = safeCurrentPrice + safeNewAddonTotal;

    // Addon unit price for this billing cycle
    const addonUnitPrice = this.getAddonUnitPrice(billingCycle);
    const addonUnitPriceCents = this.getAddonUnitPriceCents(billingCycle);

    let immediateCharge: number;
    let prorationDetails: any = undefined;

    if (addonCostDifference > 0) {
      // Adding addons - calculate prorated charge for remaining period
      const proratedCharge = await this.calculateAddonProratedCharge(
        currentState.stripe_subscription_id,
        addonCostDifference
      );
      immediateCharge = proratedCharge;

      prorationDetails = {
        days_remaining: 0,
        estimated_credit: 0,
        estimated_cost: Math.round(immediateCharge * 100) // cents
      };
    } else if (addonCostDifference < 0) {
      // No refund for addon removal (monthly or yearly).
      // Addon is removed from recurring billing, no credit issued.
      immediateCharge = 0;
      prorationDetails = {
        days_remaining: 0,
        estimated_credit: 0,
        estimated_cost: 0
      };
    } else {
      // No change
      immediateCharge = 0;
    }

    // Build itemized breakdown
    const items: Array<{type: 'base' | 'addon'; name: string; quantity?: number; unit_price: number; total_price: number}> = [];
    const currentPlanDetails = getPlanById(currentState.plan_id);

    // Add base plan
    items.push({
      type: 'base',
      name: `${currentPlanDetails?.name || 'Current Plan'} (${billingCycle})`,
      unit_price: Math.round(safeCurrentPrice * 100),
      total_price: Math.round(safeCurrentPrice * 100)
    });

    // Add addons if any
    if (newAddons.additional_projects && newAddons.additional_projects > 0) {
      items.push({
        type: 'addon',
        name: 'Additional Projects',
        quantity: newAddons.additional_projects,
        unit_price: addonUnitPriceCents,
        total_price: addonUnitPriceCents * newAddons.additional_projects
      });
    }

    if (newAddons.additional_collaborators && newAddons.additional_collaborators > 0) {
      items.push({
        type: 'addon',
        name: 'Additional Collaborators',
        quantity: newAddons.additional_collaborators,
        unit_price: addonUnitPriceCents,
        total_price: addonUnitPriceCents * newAddons.additional_collaborators
      });
    }

    return {
      type: 'subscription_change',
      billing_cycle: billingCycle,
      current_plan: currentState.plan_id,
      target_plan: currentState.plan_id, // Same plan, just addon changes
      cost_breakdown: {
        base_plan_cost: Math.round(safeCurrentPrice * 100), // cents
        addon_costs: Math.round(safeNewAddonTotal * 100), // cents
        total_immediate_charge: Math.round(immediateCharge * 100), // cents (negative for refunds)
        next_billing_amount: Math.round(totalNewCost * 100), // cents
        next_billing_date: currentPeriodEnd.toISOString(),
        currency: 'eur',
        items
      },
      proration_details: prorationDetails,
      summary: addonCostDifference > 0
        ? `Add addons: Prorated charge €${immediateCharge.toFixed(2)} for current period, then €${addonUnitPrice}/${billingLabel} per addon`
        : addonCostDifference < 0
          ? billingCycle === 'yearly'
            ? `Remove addons: Prorated refund of €${Math.abs(immediateCharge).toFixed(2)} for remaining period`
            : `Remove addons: No immediate refund, will save €${Math.abs(addonCostDifference).toFixed(2)}/${billingLabel} starting next billing cycle`
          : `No addon changes`
    };
  }

  private async previewDowngradeToFree(currentState: SubscriptionState, currentPlan: any): Promise<BillingPreview> {
    if (!currentState.stripe_subscription_id) {
      throw new Error('No active subscription to downgrade');
    }

    const subscription = await stripe.subscriptions.retrieve(currentState.stripe_subscription_id);
    const currentPeriodEnd = this.getSubscriptionPeriodEnd(subscription);

    // Calculate refund for unused portion (Stripe cancels immediately with refund)
    const { proration } = await this.calculateProration(subscription, currentPlan, { price: 0, name: 'Free' });
    let refundAmount = Math.abs(Math.min(0, proration.credit)); // Get positive refund amount

    // CRITICAL: Check for existing customer balance (unused credits from previous downgrades)
    let existingBalance = 0;
    if (currentState.stripe_customer_id) {
      try {
        const customer = await stripe.customers.retrieve(currentState.stripe_customer_id);
        if ('balance' in customer && customer.balance && customer.balance < 0) {
          existingBalance = Math.abs(customer.balance) / 100; // Convert from cents to euros
        }
      } catch (balanceError) {
        console.warn('⚠️ Could not retrieve customer balance:', balanceError);
      }
    }

    // Total refund = subscription refund + existing balance
    const totalRefundAmount = refundAmount + existingBalance;
    const now = getCurrentDate();
    const daysRemaining = Math.max(0, Math.ceil((currentPeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

    return {
      type: 'cancellation',
      current_plan: currentState.plan_id,
      target_plan: 'free',
      cost_breakdown: {
        base_plan_cost: 0, // cents (free plan)
        addon_costs: 0, // cents (no addons on free)
        total_immediate_charge: totalRefundAmount > 0 ? Math.round(this.roundCustomerFriendly(-totalRefundAmount, true) * 100) : 0, // cents (negative for refund)
        next_billing_amount: 0, // cents (free plan)
        currency: 'eur'
      },
      proration_details: totalRefundAmount > 0 ? {
        days_remaining: daysRemaining,
        estimated_credit: Math.round(this.roundCustomerFriendly(totalRefundAmount, true) * 100), // cents
        estimated_cost: 0 // cents
      } : undefined,
      summary: totalRefundAmount > 0
        ? `Downgrade to Free: €${this.roundCustomerFriendly(totalRefundAmount, true).toFixed(2)} refund will be processed within 3-5 business days (includes ${existingBalance > 0 ? 'unused credits + ' : ''}cancellation refund). Immediate cancellation.`
        : `Downgrade to Free: Subscription cancelled immediately. Switch to Free plan features now.`
    };
  }

  /**
   * Remove all collaborators from user's projects to prepare for free plan downgrade
   */
  private async removeAllCollaborators(userId: string): Promise<void> {

    // Get all user's projects
    const { data: projects, error: projectError } = await supabase
      .from('projects')
      .select('id')
      .eq('user_id', userId);

    if (projectError) {
      console.error('❌ Error fetching projects for collaborator cleanup:', projectError);
      throw new Error('Failed to fetch projects for collaborator cleanup');
    }

    if (!projects || projects.length === 0) {
      return;
    }

    const projectIds = projects.map(p => p.id);

    // Remove all collaborators from user's projects
    const { error: removeError } = await supabase
      .from('project_collaborators')
      .update({ status: 'removed' })
      .in('project_id', projectIds)
      .eq('status', 'active');

    if (removeError) {
      console.error('❌ Error removing collaborators:', removeError);
      throw new Error('Failed to remove collaborators during cancellation');
    }
  }

  /**
   * Validate if user can cancel subscription without exceeding free plan limits
   */
  private async validateCancellationEligibility(userId: string): Promise<{
    canCancel: boolean;
    blockers: Array<{ code: string; params: Record<string, number> }>;
    currentUsage: {
      projects: number;
      collaborators: number;
    };
    cleanupRequired: {
      projectsToDelete: number;
      collaboratorsToRemove: number;
      collaboratorCleanupOptions?: string[];
    };
  }> {

    // Get current project count
    const { data: projects, error: projectError } = await supabase
      .from('projects')
      .select('id, name, status')
      .eq('user_id', userId)
      .neq('status', 'archived'); // Don't count archived projects

    if (projectError) {
      console.error('❌ Error fetching projects:', projectError);
      throw new Error('Failed to check project usage');
    }

    // Get current collaborator count across all projects
    const { data: collaborators, error: collabError } = await supabase
      .from('project_collaborators')
      .select('user_id, project_id, role')
      .in('project_id', projects?.map(p => p.id) || [])
      .eq('status', 'active');

    if (collabError) {
      console.error('❌ Error fetching collaborators:', collabError);
      throw new Error('Failed to check collaborator usage');
    }

    const currentProjectCount = projects?.length || 0;
    const currentCollaboratorCount = collaborators?.length || 0;

    // Free plan limits
    const FREE_PLAN_LIMITS = { projects: 1, collaborators: 1 };

    // TRANSLATION-READY: Send structured error data instead of hardcoded English text
    const blockers: Array<{ code: string; params: Record<string, number> }> = [];
    const cleanupRequired = {
      projectsToDelete: Math.max(0, currentProjectCount - FREE_PLAN_LIMITS.projects),
      collaboratorsToRemove: Math.max(0, currentCollaboratorCount - FREE_PLAN_LIMITS.collaborators),
      collaboratorCleanupOptions: [] as string[]
    };

    // Check project limits
    if (currentProjectCount > FREE_PLAN_LIMITS.projects) {
      const excess = currentProjectCount - FREE_PLAN_LIMITS.projects;
      blockers.push({
        code: 'projects_exceed_limit',
        params: {
          current: currentProjectCount,
          limit: FREE_PLAN_LIMITS.projects,
          excess: excess
        }
      });
    }

    // Check collaborator limits
    if (currentCollaboratorCount > FREE_PLAN_LIMITS.collaborators) {
      const excess = currentCollaboratorCount - FREE_PLAN_LIMITS.collaborators;
      blockers.push({
        code: 'collaborators_exceed_limit',
        params: {
          current: currentCollaboratorCount,
          limit: FREE_PLAN_LIMITS.collaborators,
          excess: excess
        }
      });

      // Provide collaborator cleanup options (these will also be translated on frontend)
      cleanupRequired.collaboratorCleanupOptions = [
        'manual_removal',
        'auto_removal_with_confirmation'
      ];
    }

    return {
      canCancel: blockers.length === 0,
      blockers,
      currentUsage: {
        projects: currentProjectCount,
        collaborators: currentCollaboratorCount
      },
      cleanupRequired
    };
  }

  /**
   * Validate if user can reduce addons without exceeding the new effective limits
   */
  private async validateAddonChangeEligibility(
    userId: string,
    currentState: SubscriptionState,
    newAddons: { additional_projects: number; additional_collaborators: number }
  ): Promise<{
    canChange: boolean;
    blockers: Array<{ code: string; params: Record<string, number> }>;
    currentUsage: {
      projects: number;
      collaborators: number;
    };
    newEffectiveLimits: {
      projects: number;
      collaborators: number;
    };
  }> {
    // Get base plan limits
    const currentPlan = getPlanById(currentState.plan_id);
    if (!currentPlan) {
      throw new Error(`Current plan not found: ${currentState.plan_id}`);
    }

    const baseProjectLimit = currentPlan.limits.projects;
    const baseCollaboratorLimit = currentPlan.limits.collaborators;

    // Calculate new effective limits
    const newEffectiveProjectLimit = baseProjectLimit + newAddons.additional_projects;
    const newEffectiveCollaboratorLimit = baseCollaboratorLimit + newAddons.additional_collaborators;

    // Get current project count (non-archived) - includes trashed projects as they still count against limit
    const { data: projects, error: projectError } = await supabase
      .from('projects')
      .select('id')
      .eq('user_id', userId)
      .neq('status', 'archived');

    if (projectError) {
      console.error('❌ Error fetching projects:', projectError);
      throw new Error('Failed to check project usage');
    }

    // Get current collaborator count across all projects
    const { data: collaborators, error: collabError } = await supabase
      .from('project_collaborators')
      .select('user_id, project_id')
      .in('project_id', projects?.map(p => p.id) || [])
      .eq('status', 'active');

    if (collabError) {
      console.error('❌ Error fetching collaborators:', collabError);
      throw new Error('Failed to check collaborator usage');
    }

    const currentProjectCount = projects?.length || 0;
    const currentCollaboratorCount = collaborators?.length || 0;

    const blockers: Array<{ code: string; params: Record<string, number> }> = [];

    // Check if reducing project addons would exceed new limit
    if (currentProjectCount > newEffectiveProjectLimit) {
      const excess = currentProjectCount - newEffectiveProjectLimit;
      blockers.push({
        code: 'addon_reduction_projects_exceed_limit',
        params: {
          current: currentProjectCount,
          newLimit: newEffectiveProjectLimit,
          excess: excess
        }
      });
    }

    // Check if reducing collaborator addons would exceed new limit
    if (currentCollaboratorCount > newEffectiveCollaboratorLimit) {
      const excess = currentCollaboratorCount - newEffectiveCollaboratorLimit;
      blockers.push({
        code: 'addon_reduction_collaborators_exceed_limit',
        params: {
          current: currentCollaboratorCount,
          newLimit: newEffectiveCollaboratorLimit,
          excess: excess
        }
      });
    }

    return {
      canChange: blockers.length === 0,
      blockers,
      currentUsage: {
        projects: currentProjectCount,
        collaborators: currentCollaboratorCount
      },
      newEffectiveLimits: {
        projects: newEffectiveProjectLimit,
        collaborators: newEffectiveCollaboratorLimit
      }
    };
  }

  private async previewCancellation(currentState: SubscriptionState, userId: string): Promise<BillingPreview> {
    if (!currentState.stripe_subscription_id) {
      throw new Error('No active subscription to cancel');
    }

    const currentPlan = getPlanById(currentState.plan_id);
    if (!currentPlan) {
      throw new Error(`Current plan not found: ${currentState.plan_id}`);
    }

    // CRITICAL: Check if user can cancel without exceeding free plan limits
    const usageCheck = await this.validateCancellationEligibility(userId);

    const subscription = await stripe.subscriptions.retrieve(currentState.stripe_subscription_id);
    const currentPeriodEnd = this.getSubscriptionPeriodEnd(subscription);
    const detectedBillingCycle = await this.detectBillingCycle(currentState.stripe_subscription_id);
    const basePlanPrice = detectedBillingCycle === 'yearly' ? (currentPlan.yearlyPrice || 0) : (currentPlan.price || 0);

    const currentAddonCosts = this.calculateCurrentAddonCosts(currentState.plan_id, currentState, detectedBillingCycle);
    const safeCurrentPrice = Number(basePlanPrice) || 0;
    const safeCurrentAddonTotal = Number(currentAddonCosts.total) || 0;
    const totalCurrentCost = safeCurrentPrice + safeCurrentAddonTotal;

    // If user cannot cancel due to exceeding limits, return blocking preview
    if (!usageCheck.canCancel) {
      return {
        type: 'cancellation',
        current_plan: currentState.plan_id,
        target_plan: 'free',
        cost_breakdown: {
          base_plan_cost: 0,
          addon_costs: 0,
          total_immediate_charge: 0,
          next_billing_amount: 0,
          currency: 'eur'
        },
        summary: `Cannot cancel: You must reduce usage to free plan limits first`,
        validation_errors: usageCheck.blockers,
        cleanup_required: usageCheck.cleanupRequired,
        current_usage: usageCheck.currentUsage,
        blocked: true
      };
    }

    // User can cancel - show normal cancellation preview
    return {
      type: 'cancellation',
      current_plan: currentState.plan_id,
      target_plan: 'free',
      cost_breakdown: {
        base_plan_cost: 0, // cents (free plan)
        addon_costs: 0, // cents (no addons on free)
        total_immediate_charge: 0, // cents (no immediate charge for cancellation)
        next_billing_amount: 0, // cents (free plan)
        currency: 'eur'
      },
      summary: `Cancel subscription: Access until ${currentPeriodEnd.toLocaleDateString()}, then downgrade to Free plan`,
      cleanup_required: usageCheck.cleanupRequired
    };
  }

  // Private methods for executing changes

  private async executeNewSubscription(userId: string, currentState: SubscriptionState, request: BillingChangeRequest): Promise<{ success: boolean; message: string; details?: any }> {
    const targetPlan = request.target_plan!;
    const billingCycle = request.billing_cycle || 'monthly';

    // NEW MODEL VALIDATION: Only allow "paid" plan creation
    if (targetPlan !== 'paid') {
      throw new Error(`Invalid target plan "${targetPlan}". New model only supports "paid" plan subscriptions. Legacy plans (pro/teams/business) are deprecated.`);
    }

    // Ensure user is currently on free plan
    if (currentState.plan_id !== 'free') {
      throw new Error(`Cannot create new subscription. User is already on ${currentState.plan_id} plan. Use addon_change for modifications or cancel first.`);
    }

    const priceId = getStripePriceId(targetPlan, billingCycle);

    if (!priceId) {
      throw new Error(`Stripe price ID not found for plan ${targetPlan} (${billingCycle})`);
    }

    // Create embedded checkout session for new subscription
    const session = await stripeService.createCheckoutSession(userId, priceId, {
      plan_id: targetPlan,
      billing_cycle: billingCycle
    }, true, request.currency); // Enable embedded mode + multi-currency

    // SECURITY FIX: Do NOT update plan before payment confirmation
    // The plan will only be upgraded when the webhook confirms payment success
    // Only update subscription status to track the pending payment
    await this.updateLocalSubscriptionState(userId, {
      plan_id: 'free', // Keep on free plan until payment confirmed
      subscription_status: 'incomplete',
      addons: { additional_projects: 0, additional_collaborators: 0 } // No addons until payment confirmed
    });

    return {
      success: true,
      message: 'Embedded checkout session created for new subscription',
      details: {
        session_id: session.id,
        client_secret: session.client_secret,
        embedded: true
      }
    };
  }

  private async executePlanChange(userId: string, currentState: SubscriptionState, request: BillingChangeRequest): Promise<{ success: boolean; message: string; details?: any }> {
    const targetPlan = request.target_plan!;

    if (targetPlan === 'free') {
      return await this.executeDowngradeToFree(userId, currentState);
    }

    // Check if this is an upgrade or downgrade
    const currentPlan = getPlanById(currentState.plan_id);
    const newPlan = getPlanById(targetPlan);

    if (!currentPlan || !newPlan) {
      throw new Error('Plan not found');
    }

    const isDowngrade = newPlan.price < currentPlan.price;

    if (isDowngrade) {
      // For downgrades, issue direct refund instead of credits to prevent stranding
      return await this.executeDowngradeWithDirectRefund(userId, currentState, request);
    }

    // For upgrades, continue with normal Stripe proration
    const newPriceId = getStripePriceId(targetPlan, 'monthly');
    if (!newPriceId) {
      throw new Error(`Stripe price ID not found for plan ${targetPlan}`);
    }

    const subscription = await stripe.subscriptions.retrieve(currentState.stripe_subscription_id!);

    // Update subscription items for immediate proration
    const items = [];

    // Base plan item
    items.push({
      id: subscription.items.data[0].id,
      price: newPriceId
    });

    // Handle addon compatibility when changing plans
    let finalAddons = { additional_projects: 0, additional_collaborators: 0 };

    // If addons are explicitly specified in request, use those
    if (request.addons) {
      finalAddons = { ...finalAddons, ...request.addons };
    } else {
      // If no addons specified, carry over existing compatible addons
      finalAddons.additional_projects = currentState.additional_projects || 0;
      finalAddons.additional_collaborators = currentState.additional_collaborators || 0;
    }

    // Filter addons based on target plan compatibility
    const targetPlanConfig = getPlanById(targetPlan);
    if (!targetPlanConfig?.addons?.additionalProjects?.enabled) {
      finalAddons.additional_projects = 0;
    }
    if (!targetPlanConfig?.addons?.additionalCollaborators?.enabled) {
      finalAddons.additional_collaborators = 0;
    }

    // Log any removed addons due to incompatibility
    const removedProjects = (currentState.additional_projects || 0) - finalAddons.additional_projects;
    const removedCollaborators = (currentState.additional_collaborators || 0) - finalAddons.additional_collaborators;

    // Update subscription with immediate proration and billing
    const updatedSubscription = await stripe.subscriptions.update(currentState.stripe_subscription_id!, {
      items: items,
      proration_behavior: 'create_prorations',
      billing_cycle_anchor: 'now' // Force immediate billing for upgrades
    });

    // For upgrades, create and finalize invoice immediately to charge the user now
    try {
      const pendingInvoice = await stripe.invoices.create({
        customer: currentState.stripe_customer_id!,
        subscription: updatedSubscription.id,
        collection_method: 'charge_automatically'
      });

      // Finalize the invoice to charge immediately
      const finalizedInvoice = await stripe.invoices.finalizeInvoice(pendingInvoice.id, {
        auto_advance: true // Attempt to pay immediately
      });

    } catch (invoiceError: any) {
      console.error('⚠️ Error creating immediate invoice for upgrade:', invoiceError.message);
      // Don't fail the whole operation - the subscription update succeeded
      // The proration will be handled in the next billing cycle
    }

    // Update local state with final addon quantities (after compatibility filtering)
    await this.updateLocalSubscriptionState(userId, {
      plan_id: targetPlan,
      subscription_status: 'active',
      addons: finalAddons
    });

    return {
      success: true,
      message: `Successfully upgraded to ${targetPlan} plan with automatic proration`,
      details: {
        subscription_id: updatedSubscription.id,
        proration_handled_by_stripe: true
      }
    };
  }

  private async executeAddonChange(userId: string, currentState: SubscriptionState, request: BillingChangeRequest): Promise<{ success: boolean; message: string; details?: any }> {

    // NEW MODEL VALIDATION: Only allow addon changes for paid plans
    if (currentState.plan_id === 'free') {
      throw new Error('Cannot modify addons. User must subscribe to Pro plan first. Use type "new" with target_plan "paid".');
    }

    // Block addon additions if subscription is set to cancel
    if (currentState.cancel_at_period_end) {
      const hasNewAddons = (request.addons?.additional_projects ?? 0) > (currentState.additional_projects || 0) ||
        (request.addons?.additional_collaborators ?? 0) > (currentState.additional_collaborators || 0);
      if (hasNewAddons) {
        throw new Error('Cannot add addons while subscription is set to cancel. Reactivate your subscription first.');
      }
    }

    const newAddons = this.mergeAddons(currentState, request.addons);

    // CRITICAL: Validate that reducing addons won't exceed new effective limits
    const addonValidation = await this.validateAddonChangeEligibility(userId, currentState, newAddons);
    if (!addonValidation.canChange) {
      const errorMessages = addonValidation.blockers.map(b => {
        if (b.code === 'addon_reduction_projects_exceed_limit') {
          return `You have ${b.params.current} active projects but reducing addons would only allow ${b.params.newLimit}. Please archive or delete ${b.params.excess} project(s) first.`;
        } else if (b.code === 'addon_reduction_collaborators_exceed_limit') {
          return `You have ${b.params.current} collaborators but reducing addons would only allow ${b.params.newLimit}. Please remove ${b.params.excess} collaborator(s) first.`;
        }
        return `Usage exceeds new limits`;
      });
      throw new Error(errorMessages.join(' '));
    }

    // Detect billing cycle to use correct addon pricing
    const billingCycle = await this.detectBillingCycle(currentState.stripe_subscription_id!);
    const addonUnitPrice = this.getAddonUnitPrice(billingCycle);
    const billingLabel = billingCycle === 'yearly' ? 'year' : 'month';

    // Calculate addon cost difference using correct billing cycle pricing
    const currentAddonCosts = this.calculateCurrentAddonCosts(currentState.plan_id, currentState, billingCycle);
    const newAddonCosts = this.calculateAddonCosts(currentState.plan_id, newAddons, billingCycle);
    const addonCostDifference = newAddonCosts.total - currentAddonCosts.total;

    // HYBRID SYSTEM: Handle immediate prorated charges for addon additions
    if (addonCostDifference > 0) {
      try {
        // Calculate prorated charge for current billing period
        const proratedCharge = await this.calculateAddonProratedCharge(
          currentState.stripe_subscription_id!,
          addonCostDifference
        );

        if (proratedCharge > 0) {

          // Get the payment method from the subscription
          const subscription = await stripe.subscriptions.retrieve(currentState.stripe_subscription_id!);
          const defaultPaymentMethod = subscription.default_payment_method as string | null;

          if (!defaultPaymentMethod) {
            console.error('❌ No payment method found on subscription');
            throw new Error('No payment method available. Please update your payment method in billing settings.');
          }

          // Create invoice items for the prorated addon charge
          const invoiceItems: Array<{ description: string; amount: number; quantity: number }> = [];

          if (newAddons.additional_projects > (currentState.additional_projects || 0)) {
            const projectIncrease = newAddons.additional_projects - (currentState.additional_projects || 0);
            const projectProratedCharge = await this.calculateAddonProratedCharge(
              currentState.stripe_subscription_id!,
              projectIncrease * addonUnitPrice
            );
            if (projectProratedCharge > 0) {
              invoiceItems.push({
                description: `Additional Projects (${projectIncrease} × €${addonUnitPrice}/${billingLabel}, prorated)`,
                amount: Math.round(projectProratedCharge * 100),
                quantity: 1
              });
            }
          }

          if (newAddons.additional_collaborators > (currentState.additional_collaborators || 0)) {
            const collaboratorIncrease = newAddons.additional_collaborators - (currentState.additional_collaborators || 0);
            const collaboratorProratedCharge = await this.calculateAddonProratedCharge(
              currentState.stripe_subscription_id!,
              collaboratorIncrease * addonUnitPrice
            );
            if (collaboratorProratedCharge > 0) {
              invoiceItems.push({
                description: `Additional Collaborators (${collaboratorIncrease} × €${addonUnitPrice}/${billingLabel}, prorated)`,
                amount: Math.round(collaboratorProratedCharge * 100),
                quantity: 1
              });
            }
          }

          // Create invoice first (draft status) with payment method
          const invoice = await stripe.invoices.create({
            customer: currentState.stripe_customer_id!,
            collection_method: 'charge_automatically',
            default_payment_method: defaultPaymentMethod,
            description: `Prorated addon charge (${billingCycle}): ${newAddons.additional_projects} additional projects, ${newAddons.additional_collaborators} additional collaborators`,
            metadata: {
              user_id: userId,
              subscription_id: currentState.stripe_subscription_id!,
              charge_type: 'addon_prorated_charge',
              billing_cycle: billingCycle,
              full_period_cost: addonCostDifference.toString(),
              prorated_amount: proratedCharge.toString()
            }
          });

          // Add invoice items to the draft invoice
          for (const item of invoiceItems) {
            await stripe.invoiceItems.create({
              customer: currentState.stripe_customer_id!,
              invoice: invoice.id,
              amount: item.amount,
              currency: 'eur',
              description: item.description,
              metadata: {
                user_id: userId,
                subscription_id: currentState.stripe_subscription_id!,
                charge_type: 'addon_prorated_charge',
                billing_cycle: billingCycle,
                additional_projects: newAddons.additional_projects.toString(),
                additional_collaborators: newAddons.additional_collaborators.toString()
              }
            });
          }

          // Finalize the invoice
          const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

          // Only pay if not already paid (auto-collection may have already charged it)
          if (finalizedInvoice.status !== 'paid') {
            await stripe.invoices.pay(finalizedInvoice.id);
          }
        }

      } catch (chargeError: any) {
        console.error('❌ Error creating prorated charge for addon addition:', chargeError.message);
        throw new Error(`Failed to charge for addon addition: ${chargeError.message}`);
      }
    }
    // No refund/credit for addon removal (monthly or yearly).
    // The user paid for the current period and the addon is simply removed
    // from recurring billing so it won't charge on the next cycle.

    await this.syncAddonSubscriptionItems(
      currentState.stripe_subscription_id!,
      currentState.plan_id,
      newAddons,
      billingCycle
    );

    await this.updateLocalSubscriptionState(userId, {
      plan_id: currentState.plan_id,
      subscription_status: currentState.subscription_status,
      addons: newAddons
    });

    return {
      success: true,
      message: addonCostDifference > 0
        ? `Addons added successfully. Charged prorated amount for current billing period, recurring billing set up (${billingCycle}).`
        : addonCostDifference < 0
          ? `Addons removed successfully. Change takes effect on next billing cycle.`
          : `Addon settings updated successfully`,
      details: {
        addon_change: true,
        additional_projects: newAddons.additional_projects,
        additional_collaborators: newAddons.additional_collaborators,
        cost_difference: addonCostDifference,
        billing_cycle: billingCycle,
        billing_method: 'hybrid_prorated_and_recurring'
      }
    };
  }

  private async executeCancellation(userId: string, currentState: SubscriptionState, request?: BillingChangeRequest): Promise<{ success: boolean; message: string; details?: any }> {
    // NEW MODEL VALIDATION: Only allow cancellation of paid plans
    if (currentState.plan_id === 'free') {
      throw new Error('Cannot cancel subscription. User is already on free plan.');
    }

    // CRITICAL: Re-validate cancellation eligibility before execution
    const usageCheck = await this.validateCancellationEligibility(userId);

    if (!usageCheck.canCancel) {
      throw new Error(`Cancellation blocked: ${usageCheck.blockers.join('; ')}`);
    }

    // Handle collaborator cleanup if auto-removal was requested
    const autoRemoveCollaborators = request?.immediate_cancellation || false; // Using this flag for auto-removal

    if (autoRemoveCollaborators && usageCheck.cleanupRequired.collaboratorsToRemove > 0) {
      await this.removeAllCollaborators(userId);
    }

    // Cancel subscription at period end (not immediately)
    if (currentState.stripe_subscription_id) {

      const updatedSubscription = await stripe.subscriptions.update(currentState.stripe_subscription_id, {
        cancel_at_period_end: true
      });

      // Try to get period end from Stripe response first
      let periodEnd: Date | null = null;
      const periodEndTimestamp = (updatedSubscription as any).current_period_end;

      if (periodEndTimestamp) {
        periodEnd = new Date(periodEndTimestamp * 1000);
        if (isNaN(periodEnd.getTime())) {
          periodEnd = null; // Invalid date, use fallback
        }
      }

      // Fallback: Get period_end from user_subscriptions table in database
      if (!periodEnd) {
       
        const { data: subData, error: subError } = await supabase
          .from('user_subscriptions')
          .select('current_period_end')
          .eq('user_id', userId)
          .single();

        if (subError || !subData?.current_period_end) {
          console.warn('⚠️ No period_end in database, using 30 days from now as fallback');
          periodEnd = new Date();
          periodEnd.setDate(periodEnd.getDate() + 30);
        } else {
          periodEnd = new Date(subData.current_period_end);
        }
      }

      // Update local state to reflect "will cancel at period end" but keep current plan active
      await this.updateLocalSubscriptionState(userId, {
        plan_id: currentState.plan_id, // Keep current plan until period end
        subscription_status: 'active', // Still active until period end
        cancel_at_period_end: true,
        stripe_subscription_id: currentState.stripe_subscription_id,
        addons: {
          additional_projects: currentState.additional_projects,
          additional_collaborators: currentState.additional_collaborators
        }
      });

      return {
        success: true,
        message: `Subscription will cancel at period end (${periodEnd.toLocaleDateString()}). You can continue using all features until then.`,
        details: {
          period_end: periodEnd.toISOString(),
          immediate_cancellation: false,
          collaborators_removed: autoRemoveCollaborators ? usageCheck.cleanupRequired.collaboratorsToRemove : 0
        }
      };
    }

    // Fallback for users without Stripe subscription (shouldn't happen)
    await this.updateLocalSubscriptionState(userId, {
      plan_id: 'free',
      subscription_status: 'cancelled',
      stripe_subscription_id: null,
      addons: { additional_projects: 0, additional_collaborators: 0 }
    });

    return {
      success: true,
      message: 'Subscription cancelled successfully, downgraded to free plan'
    };
  }

  private async executeDowngradeWithDirectRefund(userId: string, currentState: SubscriptionState, request: BillingChangeRequest): Promise<{ success: boolean; message: string; details?: any }> {
    const targetPlan = request.target_plan!;
    const currentPlan = getPlanById(currentState.plan_id);
    const newPlan = getPlanById(targetPlan);

    if (!currentPlan || !newPlan) {
      throw new Error('Plan not found');
    }

    // Calculate refund amount for unused time
    const subscription = await stripe.subscriptions.retrieve(currentState.stripe_subscription_id!);
    const { proration } = await this.calculateProration(subscription, currentPlan, newPlan);
    const refundAmount = Math.abs(Math.min(0, proration.credit)); // Get positive refund amount

    // Step 1: Update subscription to new plan WITHOUT proration (proration_behavior: 'none')
    const newPriceId = getStripePriceId(targetPlan, 'monthly');
    if (!newPriceId) {
      throw new Error(`Stripe price ID not found for plan ${targetPlan}`);
    }

    const updatedSubscription = await stripe.subscriptions.update(currentState.stripe_subscription_id!, {
      items: [{
        id: subscription.items.data[0].id,
        price: newPriceId
      }],
      proration_behavior: 'none', // Disable automatic proration to prevent credits
      billing_cycle_anchor: 'unchanged' // Keep same billing cycle
    });

    // Step 2: Issue direct refund if there's a refund due
    let actualRefundIssued = 0;
    if (refundAmount > 0 && currentState.stripe_customer_id) {
      try {
        // Find a recent paid invoice to refund against
        const paidInvoices = await stripe.invoices.list({
          customer: currentState.stripe_customer_id,
          limit: 10,
          status: 'paid'
        });

        if (paidInvoices.data.length > 0) {
          const latestPaidInvoice = paidInvoices.data[0];

          // Create credit note for direct refund
          const creditNote = await stripe.creditNotes.create({
            invoice: latestPaidInvoice.id,
            amount: Math.round(refundAmount * 100), // Convert to cents
            reason: 'product_unsatisfactory',
            refund_amount: Math.round(refundAmount * 100), // Issue immediate refund
            metadata: {
              user_id: userId,
              reason: 'downgrade_direct_refund',
              original_plan: currentPlan.name,
              target_plan: newPlan.name,
              refund_amount: refundAmount.toFixed(2)
            }
          });

          actualRefundIssued = refundAmount;

        } else {
          console.warn(`⚠️ No paid invoices found for refund - will create customer balance credit`);

          // Fallback: Add to customer balance if no invoices to refund
          await stripe.customers.update(currentState.stripe_customer_id, {
            balance: Math.round(-refundAmount * 100) // Negative balance = credit
          });
        }

      } catch (refundError) {
        console.error('❌ Direct refund failed:', refundError);
      }
    }

    // Step 3: Update local state
    await this.updateLocalSubscriptionState(userId, {
      plan_id: targetPlan,
      subscription_status: 'active',
      addons: { additional_projects: 0, additional_collaborators: 0 }
    });

    const message = actualRefundIssued > 0
      ? `Successfully downgraded to ${newPlan.name}. Your €${actualRefundIssued.toFixed(2)} refund will be processed within 3-5 business days.`
      : `Successfully downgraded to ${newPlan.name}.`;

    return {
      success: true,
      message,
      details: {
        direct_refund_issued: actualRefundIssued,
        subscription_id: updatedSubscription.id,
        no_credits_created: true
      }
    };
  }

  private async executeDowngradeToFree(userId: string, currentState: SubscriptionState): Promise<{ success: boolean; message: string; details?: any }> {
    let refundAmount = 0;
    let actualRefundIssued = 0;
    let existingBalance = 0;

    // STEP 1: Check for existing customer balance (unused credits)
    if (currentState.stripe_customer_id) {
      try {
        const customer = await stripe.customers.retrieve(currentState.stripe_customer_id);
        if ('balance' in customer && customer.balance) {
          existingBalance = Math.abs(customer.balance) / 100; // Convert from cents to euros, make positive
        }
      } catch (balanceError) {
        console.warn('⚠️ Could not retrieve customer balance:', balanceError);
      }
    }

    // Calculate potential refund - try multiple methods
    try {
      // Method 1: Use preview calculation
      const preview = await this.previewPlanChange(currentState, {
        type: 'cancel',
        target_plan: 'free'
      });

      // Extract refund amount from preview (negative charge means refund)
      if (preview.cost_breakdown.total_immediate_charge < 0) {
        refundAmount = Math.abs(preview.cost_breakdown.total_immediate_charge / 100); // Convert from cents to euros
      } else if (preview.proration_details?.estimated_credit) {
        // Fallback: use proration details if available
        refundAmount = preview.proration_details.estimated_credit / 100; // Convert from cents to euros
      } else {

        // Method 2: Direct calculation if preview fails
        if (currentState.stripe_subscription_id) {
          try {
            const subscription = await stripe.subscriptions.retrieve(currentState.stripe_subscription_id);
            const now = new Date();
            const currentPeriodEnd = new Date((subscription as any).current_period_end * 1000);
            const currentPeriodStart = new Date((subscription as any).current_period_start * 1000);

            // Calculate remaining time
            const totalPeriodMs = currentPeriodEnd.getTime() - currentPeriodStart.getTime();
            const remainingMs = currentPeriodEnd.getTime() - now.getTime();
            const remainingRatio = Math.max(0, remainingMs / totalPeriodMs);

            // Get current plan price
            const currentPlan = getPlanById(currentState.plan_id);
            const planPrice = currentPlan ? currentPlan.price : 0;

            // Calculate refund
            refundAmount = planPrice * remainingRatio;

          } catch (directCalcError) {
            console.error('❌ Direct refund calculation failed:', directCalcError);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error getting refund preview:', error);
    }

    // STEP 1: Cancel subscription with automatic prorated refund
    if (currentState.stripe_customer_id && currentState.stripe_subscription_id) {
      try {
        // Cancel subscription with invoice_now=true and prorate=true for automatic refund
        const cancelledSubscription = await stripe.subscriptions.cancel(currentState.stripe_subscription_id, {
          invoice_now: true,  // Generate final invoice for any un-invoiced usage
          prorate: true       // Generate proration invoice item that credits remaining unused time
        });
        // Check if a final invoice was created with the refund
        if (cancelledSubscription.latest_invoice) {
          const finalInvoice = await stripe.invoices.retrieve(cancelledSubscription.latest_invoice as string);

          // If the final invoice has a negative amount, it represents a credit/refund
          if (finalInvoice.total < 0) {
            actualRefundIssued = Math.abs(finalInvoice.total) / 100;
          }
        }

      } catch (cancellationError: any) {
        console.error('❌ ERROR DURING SUBSCRIPTION CANCELLATION WITH AUTO-REFUND:', cancellationError.message);

        // Fallback: Try regular cancellation without auto-refund
        try {
          const cancelledSubscription = await stripe.subscriptions.cancel(currentState.stripe_subscription_id);
        } catch (fallbackError) {
          console.error('❌ FALLBACK CANCELLATION ALSO FAILED:', fallbackError);
        }
      }
    }

    // Update local state (preserve customer ID for future resubscription)
    await this.updateLocalSubscriptionState(userId, {
      plan_id: 'free',
      subscription_status: 'active',
      stripe_subscription_id: null,
      addons: { additional_projects: 0, additional_collaborators: 0 }
    });

    // Calculate total refund including existing balance
    const totalRefundAmount = refundAmount + existingBalance;
    const finalRefundIssued = Math.max(actualRefundIssued, totalRefundAmount);

    // Issue actual refund if there are unused credits to prevent stranded balance
    if (currentState.stripe_customer_id) {
      try {

        // Check for any pending invoice credits or customer balance
        const customer = await stripe.customers.retrieve(currentState.stripe_customer_id);
        let totalCreditsToRefund = 0;

        // Check customer balance
        if ('balance' in customer && customer.balance && customer.balance < 0) {
          const customerBalance = Math.abs(customer.balance) / 100;
          totalCreditsToRefund += customerBalance;
        }

        // Check for recent invoices with credits
        const recentInvoices = await stripe.invoices.list({
          customer: currentState.stripe_customer_id,
          limit: 5,
          created: {
            gte: Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60) // Last 30 days
          }
        });

        let foundCredits = 0;
        for (const invoice of recentInvoices.data) {
          if (invoice.total < 0) {
            const creditAmount = Math.abs(invoice.total) / 100;
            foundCredits += creditAmount;
          }
        }

        // Total credits to refund (customer balance + recent negative invoices)
        totalCreditsToRefund = Math.max(totalCreditsToRefund, foundCredits);

        if (totalCreditsToRefund > 0) {

          // Find a recent paid invoice to create credit note against
          const paidInvoices = await stripe.invoices.list({
            customer: currentState.stripe_customer_id,
            limit: 10,
            status: 'paid'
          });

          if (paidInvoices.data.length > 0) {
            const latestPaidInvoice = paidInvoices.data[0];

            // Create credit note for ALL unused credits
            const creditNote = await stripe.creditNotes.create({
              invoice: latestPaidInvoice.id,
              amount: Math.round(totalCreditsToRefund * 100), // Convert to cents
              reason: 'product_unsatisfactory',
              metadata: {
                user_id: userId,
                reason: 'convert_all_unused_credits_to_refund',
                total_credits_converted: totalCreditsToRefund.toFixed(2),
                cancellation_type: 'downgrade_to_free'
              }
            });

            actualRefundIssued = totalCreditsToRefund;

            // Clear customer balance if any
            if ('balance' in customer && customer.balance && customer.balance < 0) {
              await stripe.customers.update(currentState.stripe_customer_id, {
                balance: 0
              });
            }
          } else {
            console.warn(`⚠️ No paid invoices found to create credit note against`);
          }
        }

      } catch (refundError) {
        console.error('❌ Credit conversion failed:', refundError);
      }
    }

    const message = actualRefundIssued > 0
      ? `Successfully downgraded to free plan. Your €${actualRefundIssued.toFixed(2)} refund will be processed within 3-5 business days.`
      : totalRefundAmount > 0
        ? `Successfully downgraded to free plan. Your €${totalRefundAmount.toFixed(2)} refund will be processed within 3-5 business days.`
        : `Successfully downgraded to free plan.`;

    return {
      success: true,
      message,
      details: {
        calculated_refund_amount: refundAmount,
        actual_refund_issued: actualRefundIssued,
        plan_change: true
      }
    };
  }

  // Helper methods

  /**
   * Detect billing cycle (monthly vs yearly) from a Stripe subscription.
   * Looks at the base plan price item's recurring interval.
   */
  async detectBillingCycle(subscriptionId: string): Promise<'monthly' | 'yearly'> {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price']
      });

      // Find the base plan item (not addon items)
      const basePriceItem = subscription.items.data.find(item => {
        const priceId = item.price.id;
        return priceId === currentPriceIds.paid_monthly || priceId === currentPriceIds.paid_yearly;
      });

      if (basePriceItem?.price.recurring?.interval === 'year') {
        return 'yearly';
      }
      return 'monthly';
    } catch (error) {
      console.error('❌ Error detecting billing cycle:', error);
      return 'monthly'; // Safe fallback
    }
  }

  /**
   * Get the per-unit addon price for the given billing cycle.
   * Monthly: €4/unit/month, Yearly: €40/unit/year
   */
  private getAddonUnitPrice(billingCycle: 'monthly' | 'yearly'): number {
    return getAddonPriceForPlan('paid', 'additional_projects', billingCycle);
  }

  /**
   * Get the per-unit addon price in cents for display.
   */
  private getAddonUnitPriceCents(billingCycle: 'monthly' | 'yearly'): number {
    return Math.round(this.getAddonUnitPrice(billingCycle) * 100);
  }

  private calculateAddonCosts(planId: string, addons: { additional_projects?: number; additional_collaborators?: number }, billingCycle: 'monthly' | 'yearly' = 'monthly'): { projects: number; collaborators: number; total: number } {
    const plan = getPlanById(planId);
    if (!plan?.addons) {
      return { projects: 0, collaborators: 0, total: 0 };
    }

    // Ensure we have valid numbers (prevent NaN)
    const projectsCount = Math.max(0, addons.additional_projects || 0);
    const collaboratorsCount = Math.max(0, addons.additional_collaborators || 0);

    const projectsCost = plan.addons.additionalProjects?.enabled
      ? projectsCount * getAddonPriceForPlan(planId, 'additional_projects', billingCycle)
      : 0;

    const collaboratorsCost = plan.addons.additionalCollaborators?.enabled
      ? collaboratorsCount * getAddonPriceForPlan(planId, 'additional_collaborators', billingCycle)
      : 0;

    // Note: AI credits are now one-time purchases via /api/ai-credits/purchase (not subscription addons)

    // Ensure we return valid numbers
    const finalProjectsCost = Number(projectsCost.toFixed(2));
    const finalCollaboratorsCost = Number(collaboratorsCost.toFixed(2));

    return {
      projects: finalProjectsCost,
      collaborators: finalCollaboratorsCost,
      total: Number((finalProjectsCost + finalCollaboratorsCost).toFixed(2))
    };
  }

  private calculateCurrentAddonCosts(planId: string, currentState: SubscriptionState, billingCycle: 'monthly' | 'yearly' = 'monthly'): { projects: number; collaborators: number; total: number } {
    return this.calculateAddonCosts(planId, {
      additional_projects: currentState.additional_projects,
      additional_collaborators: currentState.additional_collaborators
    }, billingCycle);
  }

  private mergeAddons(currentState: SubscriptionState, newAddons?: { additional_projects?: number; additional_collaborators?: number }): { additional_projects: number; additional_collaborators: number } {
    return {
      additional_projects: newAddons?.additional_projects ?? currentState.additional_projects,
      additional_collaborators: newAddons?.additional_collaborators ?? currentState.additional_collaborators
    };
  }

  private mergeAndFilterAddons(currentState: SubscriptionState, targetPlanId: string, newAddons?: { additional_projects?: number; additional_collaborators?: number }): { additional_projects: number; additional_collaborators: number } {
    // First merge addons normally
    let finalAddons = this.mergeAddons(currentState, newAddons);

    // Then filter based on target plan compatibility
    const targetPlanConfig = getPlanById(targetPlanId);
    if (!targetPlanConfig?.addons?.additionalProjects?.enabled) {
      finalAddons.additional_projects = 0;
    }
    if (!targetPlanConfig?.addons?.additionalCollaborators?.enabled) {
      finalAddons.additional_collaborators = 0;
    }
    // Note: AI credits are now one-time purchases via /api/ai-credits/purchase (not subscription addons)

    return finalAddons;
  }

  private async calculateProration(subscription: Stripe.Subscription, currentPlan: any, targetPlan: any): Promise<{ proration: { netCharge: number; credit: number }; billingDates: { current_period_end: string; next_billing_date: string } }> {
    const now = getCurrentDate();

    // Use billing_cycle_anchor to determine current billing period
    const billingCycleAnchor = (subscription as any).billing_cycle_anchor;

    // Calculate current billing period using billing_cycle_anchor
    let currentPeriodStart: Date;
    let currentPeriodEnd: Date;

    if (billingCycleAnchor) {
      // ALWAYS use billing_cycle_anchor - this is Stripe's authoritative billing period start
      currentPeriodStart = new Date(billingCycleAnchor * 1000);
      currentPeriodEnd = calculateBillingPeriodEnd(currentPeriodStart);

    } else {
      // ERROR: billing_cycle_anchor should always be available for active subscriptions
      console.error('❌ CRITICAL ERROR: billing_cycle_anchor not found in Stripe subscription');
      throw new Error('billing_cycle_anchor not found - cannot calculate accurate proration. This should not happen for active subscriptions.');
    }

    // STRIPE DAY-BASED PRORATION LOGIC
    // Stripe calculates billing in full calendar days, not hours/seconds
    const startDate = new Date(currentPeriodStart.getFullYear(), currentPeriodStart.getMonth(), currentPeriodStart.getDate());
    const endDate = new Date(currentPeriodEnd.getFullYear(), currentPeriodEnd.getMonth(), currentPeriodEnd.getDate());
    const currentDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const totalDaysInCycle = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    const elapsedDays = Math.max(0, Math.floor((currentDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
    const remainingDays = Math.max(0, totalDaysInCycle - elapsedDays);

    // Calculate ratios based on days, not seconds
    const usageRatio = elapsedDays / totalDaysInCycle;
    const remainingRatio = remainingDays / totalDaysInCycle;


    return this.calculateProrationWithPrecision(now, currentPeriodStart, currentPeriodEnd, currentPlan, targetPlan, remainingRatio, usageRatio);
  }

  private calculateProrationWithPrecision(currentDate: Date, currentPeriodStart: Date, currentPeriodEnd: Date, currentPlan: any, targetPlan: any, remainingRatio: number, usageRatio: number): { proration: { netCharge: number; credit: number }; billingDates: { current_period_end: string; next_billing_date: string } } {
    const currentMonthlyPrice = currentPlan.price || 0;
    const targetMonthlyPrice = targetPlan.price || 0;

    // STRIPE EXACT PRORATION LOGIC
    // Calculate proration based on exact time ratios, not day approximations
    let prorationCredit: number;
    let immediateCharge: number;
    let nextBillingDate: Date;

    if (targetMonthlyPrice > currentMonthlyPrice) {
      // UPGRADE: Refund unused portion of current plan + charge full new plan
      prorationCredit = -(currentMonthlyPrice * remainingRatio);
      immediateCharge = targetMonthlyPrice;
      // Calculate next billing date based on current date + 1 month (Stripe behavior)
      // Use current change date, not original billing cycle anchor
      const nextMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, currentDate.getDate());
      nextBillingDate = nextMonth;

    } else {
      // DOWNGRADE: Only charge the net difference (no double compensation)
      // 1. Refund unused portion of current plan
      // 2. Charge only what's needed for new plan (proportional to remaining time)
      prorationCredit = -(currentMonthlyPrice * remainingRatio);
      immediateCharge = targetMonthlyPrice * remainingRatio; // Only charge for remaining time, not full month
      // Keep original billing cycle end for downgrades (no cycle reset)
      nextBillingDate = currentPeriodEnd;

    }

    // Net charge = immediate charge + proration credit
    const netCharge = immediateCharge + prorationCredit;


    return {
      proration: {
        netCharge: Number(netCharge.toFixed(2)),
        credit: Number(prorationCredit.toFixed(2))
      },
      billingDates: {
        current_period_end: nextBillingDate.toISOString(), // Use new billing cycle end
        next_billing_date: nextBillingDate.toISOString()
      }
    };
  }

  private calculateProrationWithDates(currentDate: Date, currentPeriodEnd: Date, currentPlan: any, targetPlan: any, remainingDays: number, totalDaysInCycle: number): { proration: { netCharge: number; credit: number }; billingDates: { current_period_end: string; next_billing_date: string } } {
    const currentMonthlyPrice = currentPlan.price || 0;
    const targetMonthlyPrice = targetPlan.price || 0;

    // Calculate daily rate for current plan
    const dailyCurrentRate = currentMonthlyPrice / totalDaysInCycle;

    // SIMPLIFIED STRIPE LOGIC:
    // UPGRADE: New billing cycle starts TODAY, charge = target_price - (unused_days * daily_current_rate)
    // DOWNGRADE: Keep same billing cycle end, refund = (target_price - current_price) proportional to remaining days

    let prorationCredit: number;
    let immediateCharge: number;
    let nextBillingDate: Date;

    if (targetMonthlyPrice > currentMonthlyPrice) {
      // UPGRADE: Stripe starts new billing cycle from today
      prorationCredit = -(dailyCurrentRate * remainingDays); // Refund unused current plan
      immediateCharge = targetMonthlyPrice; // Charge full new plan price
      nextBillingDate = calculateBillingPeriodEnd(currentDate); // New cycle from today

    } else {
      // DOWNGRADE: Keep current billing cycle end, just refund difference
      const dailyTargetRate = targetMonthlyPrice / totalDaysInCycle;
      const dailyDifference = dailyCurrentRate - dailyTargetRate;
      prorationCredit = -(dailyDifference * remainingDays); // Refund difference for remaining days
      immediateCharge = 0; // No immediate charge for downgrades
      nextBillingDate = currentPeriodEnd; // Keep same billing cycle

    }

    // Net charge = immediate charge + proration credit
    const netCharge = immediateCharge + prorationCredit;


    return {
      proration: {
        netCharge: Number(netCharge.toFixed(2)),
        credit: Number(prorationCredit.toFixed(2))
      },
      billingDates: {
        current_period_end: nextBillingDate.toISOString(), // New billing cycle end
        next_billing_date: nextBillingDate.toISOString()   // One month from today
      }
    };
  }

  private getSubscriptionPeriodEnd(subscription: Stripe.Subscription): Date {
    const periodEndTimestamp = (subscription as any).current_period_end;
    return periodEndTimestamp
      ? new Date(periodEndTimestamp * 1000)
      : new Date(subscription.created * 1000 + (30 * 24 * 60 * 60 * 1000));
  }

  private generateChangeSummary(changeType: string, currentPlan: any, targetPlan: any, netChange: number, currentPeriodEnd: string | null): string {
    const periodEndDate = currentPeriodEnd ? new Date(currentPeriodEnd).toLocaleDateString() : 'end of period';

    if (changeType === 'downgrade_to_free') {
      return netChange < 0
        ? `Downgrade to Free: €${Math.abs(netChange).toFixed(2)} credit will be applied to future invoices, access until ${periodEndDate}`
        : `Downgrade to Free: No refund due, access until ${periodEndDate}`;
    }

    if (changeType === 'upgrade') {
      return `Upgrade to ${targetPlan.name}: €${Math.abs(netChange).toFixed(2)} charged now (includes refund + full month), then €${targetPlan.price}/month from ${periodEndDate}`;
    }

    if (changeType === 'downgrade') {
      return netChange < 0
        ? `Downgrade to ${targetPlan.name}: €${Math.abs(netChange).toFixed(2)} refund will be processed within 3-5 business days, then €${targetPlan.price}/month from ${periodEndDate}`
        : `Downgrade to ${targetPlan.name}: €${netChange.toFixed(2)} charged now (includes refund + full month), then €${targetPlan.price}/month from ${periodEndDate}`;
    }

    return `Plan change to ${targetPlan.name}: €${Math.abs(netChange).toFixed(2)} ${netChange >= 0 ? 'charged' : 'refunded'}`;
  }

  private generateStripePoweredSummary(changeType: string, currentPlan: any, targetPlan: any, immediateCharge: number, currentPeriodEnd: string, isDowngrade: boolean = false): string {
    const periodEndDate = new Date(currentPeriodEnd).toLocaleDateString();

    if (changeType === 'cancellation') {
      return `Cancel subscription: Access until ${periodEndDate}, then downgrade to Free plan`;
    }

    if (immediateCharge > 0) {
      return `Upgrade to ${targetPlan.name}: €${immediateCharge.toFixed(2)} charged now (includes refund + full month), then €${targetPlan.price}/month from ${periodEndDate}`;
    } else if (immediateCharge < 0) {
      return isDowngrade
        ? `Downgrade to ${targetPlan.name}: €${Math.abs(immediateCharge).toFixed(2)} refund will be processed within 3-5 business days, then €${targetPlan.price}/month from ${periodEndDate}`
        : `Downgrade to ${targetPlan.name}: €${Math.abs(immediateCharge).toFixed(2)} credit will be applied to future invoices, then €${targetPlan.price}/month from ${periodEndDate}`;
    } else {
      return `Change to ${targetPlan.name}: No immediate charge, €${targetPlan.price}/month from ${periodEndDate}`;
    }
  }

  private async fallbackManualPreview(currentState: SubscriptionState, request: BillingChangeRequest, currentPlan: any, targetPlan: any): Promise<BillingPreview> {

    // Get current subscription from Stripe for exact proration
    const subscription = await stripe.subscriptions.retrieve(currentState.stripe_subscription_id!, {
      expand: ['items.data.price']
    });

    const { proration, billingDates } = await this.calculateProration(subscription, currentPlan, targetPlan);

    // Detect billing cycle for correct addon pricing
    const detectedBillingCycle = await this.detectBillingCycle(currentState.stripe_subscription_id!);

    // Handle addons with compatibility filtering
    const currentAddonCosts = this.calculateCurrentAddonCosts(currentState.plan_id, currentState, detectedBillingCycle);
    const newAddons = this.mergeAndFilterAddons(currentState, request.target_plan!, request.addons);
    const newAddonCosts = this.calculateAddonCosts(request.target_plan!, newAddons, detectedBillingCycle);

    const netChange = proration.netCharge + (newAddonCosts.total - currentAddonCosts.total);
    const changeType = request.target_plan === 'free' ? 'cancellation' : 'subscription_change';

    // Calculate remaining days properly using subscription billing period
    let daysRemaining = 0;
    if (billingDates.current_period_end) {
      const currentPeriodEnd = new Date(billingDates.current_period_end);
      const periodStartTimestamp = (subscription as any).current_period_start;

      if (periodStartTimestamp) {
        const currentPeriodStart = new Date(periodStartTimestamp * 1000);
        const now = getCurrentDate();

        const totalDays = Math.ceil((currentPeriodEnd.getTime() - currentPeriodStart.getTime()) / (1000 * 60 * 60 * 24));
        const elapsedDays = Math.ceil((now.getTime() - currentPeriodStart.getTime()) / (1000 * 60 * 60 * 24));
        daysRemaining = Math.max(0, totalDays - elapsedDays + 1); // +1 to include current day
      } else {
        // Fallback: use subscription creation date if period start is missing
        const subscriptionCreated = new Date(subscription.created * 1000);
        const now = getCurrentDate();

        // Find which billing period we're currently in if end date provided
        let periodStart = new Date(subscriptionCreated);
        let calculatedPeriodEnd = calculateBillingPeriodEnd(periodStart);

        // If the provided end date is later than first calculated period, find correct period
        while (calculatedPeriodEnd.getTime() < currentPeriodEnd.getTime()) {
          periodStart = new Date(calculatedPeriodEnd);
          calculatedPeriodEnd = calculateBillingPeriodEnd(periodStart);
        }

        const totalDays = Math.ceil((currentPeriodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24));
        const elapsedDays = Math.ceil((now.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24));
        daysRemaining = Math.max(0, totalDays - elapsedDays + 1); // +1 to include current day
      }
    }

    // Ensure we have valid prices (prevent NaN in UI)
    const safeTargetPrice = Number(targetPlan.price) || 0;
    const safeAddonTotal = Number(newAddonCosts.total) || 0;
    const safeNetChange = Number(netChange) || 0;

    return {
      type: changeType,
      current_plan: currentState.plan_id,
      target_plan: request.target_plan!,
      cost_breakdown: {
        base_plan_cost: Math.round(safeTargetPrice * 100), // cents
        addon_costs: Math.round(safeAddonTotal * 100), // cents
        total_immediate_charge: Math.round(this.roundCustomerFriendly(safeNetChange, safeNetChange < 0) * 100), // cents (can be negative for refunds)
        next_billing_amount: request.target_plan === 'free' ? 0 : Math.round((safeTargetPrice + safeAddonTotal) * 100), // cents
        currency: 'eur'
      },
      proration_details: daysRemaining > 0 ? {
        days_remaining: daysRemaining,
        estimated_credit: Math.round(this.roundCustomerFriendly(Math.abs(Math.min(0, proration.credit)), true) * 100), // cents
        estimated_cost: Math.round(this.roundCustomerFriendly(Math.max(0, netChange), false) * 100) // cents
      } : undefined,
      summary: this.generateChangeSummary(changeType, currentPlan, targetPlan, this.roundCustomerFriendly(safeNetChange, safeNetChange < 0), billingDates.current_period_end)
    };
  }



  private async updateLocalSubscriptionState(userId: string, update: {
    plan_id: string;
    subscription_status: string;
    stripe_subscription_id?: string | null;
    stripe_customer_id?: string | null;
    stripe_plan_price_id?: string | null;
    cancel_at_period_end?: boolean;
    addons?: { additional_projects?: number; additional_collaborators?: number };
  }): Promise<void> {
    // Update users table - stripe IDs for quick lookup
    const userUpdate: any = {
      updated_at: getCurrentDate().toISOString()
    };

    if (update.stripe_subscription_id !== undefined) {
      userUpdate.stripe_subscription_id = update.stripe_subscription_id;
    }

    if (update.stripe_customer_id !== undefined) {
      userUpdate.stripe_customer_id = update.stripe_customer_id;
    }

    await supabase
      .from('users')
      .update(userUpdate)
      .eq('id', userId);

    // Update user_subscriptions table - ALL subscription data lives here
    const subscriptionUpdate: any = {
      plan_id: update.plan_id,
      status: update.subscription_status,
      updated_at: getCurrentDate().toISOString()
    };

    // Add Stripe IDs to subscription record for historical tracking
    if (update.stripe_subscription_id !== undefined) {
      subscriptionUpdate.stripe_subscription_id = update.stripe_subscription_id;
    }

    if (update.stripe_customer_id !== undefined) {
      subscriptionUpdate.stripe_customer_id = update.stripe_customer_id;
    }

    if (update.stripe_plan_price_id !== undefined) {
      subscriptionUpdate.stripe_plan_price_id = update.stripe_plan_price_id;
    }

    // Add cancel_at_period_end if provided
    if (update.cancel_at_period_end !== undefined) {
      subscriptionUpdate.cancel_at_period_end = update.cancel_at_period_end;
    }

    if (update.addons) {
      subscriptionUpdate.additional_projects = update.addons.additional_projects || 0;
      subscriptionUpdate.additional_collaborators = update.addons.additional_collaborators || 0;
      // Note: AI credits are now one-time purchases via /api/ai-credits/purchase (not subscription addons)
    }

    // First, mark all existing active subscriptions as inactive ONLY if creating a NEW subscription
    // (different stripe_subscription_id than current)
    if (update.subscription_status === 'active' && update.stripe_subscription_id) {
      // Check if this is a different subscription ID
      const { data: currentSub } = await supabase
        .from('user_subscriptions')
        .select('stripe_subscription_id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle();

      // Only deactivate if the subscription ID is different (new subscription)
      if (currentSub && currentSub.stripe_subscription_id !== update.stripe_subscription_id) {
        await supabase
          .from('user_subscriptions')
          .update({ status: 'inactive', updated_at: getCurrentDate().toISOString() })
          .eq('user_id', userId)
          .eq('status', 'active');
      }
    }

    // Use upsert with proper conflict handling
    const { data, error } = await supabase
      .from('user_subscriptions')
      .upsert({
        user_id: userId,
        ...subscriptionUpdate
      }, {
        onConflict: 'user_id' // This will update the existing row for this user
      });

    if (error) {
      console.error('❌ Database update error:', error);

      // Fallback: try a direct UPDATE on active subscription only
      const { data: updateData, error: updateError } = await supabase
        .from('user_subscriptions')
        .update(subscriptionUpdate)
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(1);

      if (updateError) {
        console.error('❌ Direct UPDATE also failed:', updateError);
        throw new Error(`Failed to update subscription state: ${updateError.message}`);
      }

    }

  }

  // ================================
  // SUBSCRIPTION ITEM MANAGEMENT
  // ================================

  /**
   * Sync addon subscription items with Stripe to match target addon state
   * Used in hybrid system: immediate prorated charge + recurring subscription items
   * Note: AI credits are now one-time purchases via /api/ai-credits/purchase (not subscription addons)
   */
  private async syncAddonSubscriptionItems(
    subscriptionId: string,
    planId: string,
    targetAddons: { additional_projects: number; additional_collaborators: number },
    billingCycle: 'monthly' | 'yearly' = 'monthly'
  ): Promise<void> {
    // Get current subscription with items
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items']
    });

    const currentItems = subscription.items.data;

    // Sync additional projects
    await this.syncAddonType(
      subscriptionId,
      planId,
      'additional_projects',
      targetAddons.additional_projects,
      currentItems,
      billingCycle
    );

    // Sync additional collaborators
    await this.syncAddonType(
      subscriptionId,
      planId,
      'additional_collaborators',
      targetAddons.additional_collaborators,
      currentItems,
      billingCycle
    );
  }

  /**
   * Sync a specific addon type with Stripe subscription items.
   * Uses the correct price ID based on billing cycle (monthly vs yearly).
   * Note: AI credits are now one-time purchases, not subscription addons.
   */
  private async syncAddonType(
    subscriptionId: string,
    planId: string,
    addonType: 'additional_projects' | 'additional_collaborators',
    targetQuantity: number,
    currentItems: Stripe.SubscriptionItem[],
    billingCycle: 'monthly' | 'yearly' = 'monthly'
  ): Promise<void> {
    const priceId = getAddonPriceId(planId, addonType, billingCycle);
    // Also get the opposite billing cycle price ID to detect items that need migration
    const oppositePriceId = getAddonPriceId(planId, addonType, billingCycle === 'yearly' ? 'monthly' : 'yearly');

    if (!priceId) {
      return;
    }

    // Find existing subscription item for this addon type (check both monthly and yearly price IDs)
    const existingItem = currentItems.find(item => item.price.id === priceId);
    const wrongCycleItem = oppositePriceId ? currentItems.find(item => item.price.id === oppositePriceId) : null;

    // If there's an item with the wrong billing cycle price, remove it first
    if (wrongCycleItem) {
      await stripe.subscriptionItems.del(wrongCycleItem.id, {
        proration_behavior: 'none' // We handle proration separately
      });
    }

    const currentQuantity = existingItem?.quantity || 0;

    if (targetQuantity === 0 && existingItem) {
      // Remove subscription item (no proration to prevent credits - we handle credits separately)
      await stripe.subscriptionItems.del(existingItem.id, {
        proration_behavior: 'none'
      });

    } else if (targetQuantity > 0 && !existingItem) {
      // Create new subscription item with correct billing cycle price
      await stripe.subscriptionItems.create({
        subscription: subscriptionId,
        price: priceId,
        quantity: targetQuantity,
        proration_behavior: 'none' // No proration - we handle immediate charges separately
      });

    } else if (targetQuantity > 0 && existingItem && targetQuantity !== currentQuantity) {
      // Update existing subscription item quantity
      await stripe.subscriptionItems.update(existingItem.id, {
        quantity: targetQuantity,
        proration_behavior: 'none' // No proration - we handle immediate charges separately
      });
    }
  }

  /**
   * Calculate prorated charge for addon addition in current billing period
   */
  private async calculateAddonProratedCharge(
    subscriptionId: string,
    addonCostDifference: number
  ): Promise<number> {
    if (addonCostDifference <= 0) return 0;

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const billingCycle = calculateBillingCycleInfo(subscription);

    const proratedCharge = calculateProratedCharge(addonCostDifference, billingCycle);

    return proratedCharge;
  }
}

export const unifiedBillingService = new UnifiedBillingService();