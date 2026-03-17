import express from 'express';
import { PricingService } from '../services/pricingService';
import { PRICING_PLANS, getActivePlans, getVisiblePlans } from '../config/pricingPlans';
import { addPricingService, extractUserId, PricingRequest } from '../middleware/pricingMiddleware';
import { requireAuth } from '../middleware/auth';
import { createClient } from '@supabase/supabase-js';
import { detectCurrencyFromRequest, getPricesForCurrency, getCurrencyConfig, CurrencyCode, CURRENCY_PRICES } from '../config/currencies';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Helper function to determine if a plan change is a downgrade
function isDowngrade(currentPlan: any, newPlan: any): boolean {
  // Simplified model: only 'free' and 'paid' plans
  const planHierarchy = ['free', 'paid'];
  const currentIndex = planHierarchy.indexOf(currentPlan.id);
  const newIndex = planHierarchy.indexOf(newPlan.id);
  return currentIndex > newIndex;
}

// Helper function to validate if downgrade is allowed
async function validateDowngrade(currentSubscription: any, newPlan: any) {
  const currentUsage = {
    projects: currentSubscription.projects_count || 0,
    aiGenerations: currentSubscription.ai_generations_used || 0,
    aiImageCredits: currentSubscription.ai_image_credits_used || 0,
    collaborators: currentSubscription.collaborators_count || 0
  };

  const violations = [];
  const warnings = [];

  // Calculate maximum possible limits on new plan (including add-ons)
  const newPlanMaxLimits = {
    projects: newPlan.limits.projects,
    collaborators: newPlan.limits.collaborators
  };

  // If new plan supports project add-ons, consider maximum possible projects
  if (newPlan.addons?.additionalProjects?.enabled) {
    const maxAdditionalProjects = newPlan.addons.additionalProjects.maxAdditional || 50; // Reasonable default
    if (newPlanMaxLimits.projects !== -1) {
      newPlanMaxLimits.projects += maxAdditionalProjects;
    }
    // If projects are unlimited on new plan, keep as -1
  }

  // If new plan supports collaborator add-ons, consider maximum possible collaborators
  if (newPlan.addons?.additionalCollaborators?.enabled) {
    const maxAdditionalCollaborators = newPlan.addons.additionalCollaborators.maxAdditional || 20; // Reasonable default
    if (newPlanMaxLimits.collaborators !== -1) {
      newPlanMaxLimits.collaborators += maxAdditionalCollaborators;
    }
  }

  // Check project count against maximum possible (base + max add-ons)
  if (newPlanMaxLimits.projects !== -1 && currentUsage.projects > newPlanMaxLimits.projects) {
    violations.push(`You have ${currentUsage.projects} active projects, but the ${newPlan.name} plan can only support up to ${newPlanMaxLimits.projects} projects (including add-ons). Please delete or archive ${currentUsage.projects - newPlanMaxLimits.projects} project(s) first.`);
  } else if (newPlan.limits.projects !== -1 && currentUsage.projects > newPlan.limits.projects) {
    // Warn about potential additional costs if they exceed base limit but are within max limit
    const requiredAdditionalProjects = currentUsage.projects - newPlan.limits.projects;
    const monthlyCost = requiredAdditionalProjects * (newPlan.addons?.additionalProjects?.pricePerProject || 5);
    warnings.push(`Your ${currentUsage.projects} projects exceed the ${newPlan.name} plan's base limit of ${newPlan.limits.projects}. This will require ${requiredAdditionalProjects} additional project(s) at ${monthlyCost}/month.`);
  }

  // Check collaborators against maximum possible (base + max add-ons)
  if (newPlanMaxLimits.collaborators !== -1 && currentUsage.collaborators > newPlanMaxLimits.collaborators) {
    violations.push(`You have ${currentUsage.collaborators} collaborators, but the ${newPlan.name} plan can only support up to ${newPlanMaxLimits.collaborators} collaborators (including add-ons). Please remove ${currentUsage.collaborators - newPlanMaxLimits.collaborators} collaborator(s) first.`);
  } else if (newPlan.limits.collaborators !== -1 && currentUsage.collaborators > newPlan.limits.collaborators) {
    // Warn about potential additional costs if they exceed base limit but are within max limit
    const requiredAdditionalCollaborators = currentUsage.collaborators - newPlan.limits.collaborators;
    const monthlyCost = requiredAdditionalCollaborators * (newPlan.addons?.additionalCollaborators?.pricePerCollaborator || 10);
    warnings.push(`Your ${currentUsage.collaborators} collaborators exceed the ${newPlan.name} plan's base limit of ${newPlan.limits.collaborators}. This will require ${requiredAdditionalCollaborators} additional collaborator(s) at ${monthlyCost}/month.`);
  }

  // Note: AI generations and image credits are not checked for downgrades
  // since they represent already consumed/paid usage and don't prevent 
  // the user from using the new plan's limits going forward

  return {
    allowed: violations.length === 0,
    reason: violations.length > 0 ? violations.join(' ') : undefined,
    warnings: warnings,
    currentUsage,
    newPlanMaxLimits,
    violations,
    requiresAddons: warnings.length > 0
  };
}

// Add pricing service to all routes
router.use(addPricingService);

/**
 * Get pricing system status (restricted to authenticated users)
 */
router.get('/status', requireAuth, (req, res) => {
  res.json({
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development'
  });
});

/**
 * Get all available pricing plans
 * Accepts optional ?currency=EUR|USD|GBP query param.
 * If omitted, detects from CF-IPCountry header (EU→EUR, GB→GBP, else→USD).
 */
router.get('/plans', (req, res) => {
  try {
    const currency = detectCurrencyFromRequest(req);
    const prices = getPricesForCurrency(currency);
    const currencyConfig = getCurrencyConfig(currency);
    const plans = getVisiblePlans();

    res.json({
      plans,
      currency: currency,
      currency_symbol: currencyConfig.symbol,
      prices,
    });
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({ error: 'Failed to fetch pricing plans' });
  }
});

/**
 * Get user's current subscription and usage
 */
router.get('/subscription', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const userId = req.userId!;
    const pricingService = req.pricingService!;
    
    const analytics = await pricingService.getUsageAnalytics(userId);
    res.json(analytics);
  } catch (error) {
    console.error('Error fetching user subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription details' });
  }
});

/**
 * Check if user can perform a specific action
 */
router.post('/check-limit', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const userId = req.userId!;
    const { action } = req.body;
    const pricingService = req.pricingService!;
    
    if (!action || !['create_project', 'ai_generation', 'add_collaborator'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action specified' });
    }
    
    const result = await pricingService.canPerformAction(userId, action);
    res.json(result);
  } catch (error) {
    console.error('Error checking limit:', error);
    res.status(500).json({ error: 'Failed to check limit' });
  }
});

/**
 * Preview upgrade costs and credits
 */
router.post('/upgrade/preview', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const userId = req.userId!;
    const { planId } = req.body;
    const pricingService = req.pricingService!;
    
    if (!planId || !PRICING_PLANS[planId]) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }
    
    const newPlan = PRICING_PLANS[planId];
    const currentSubscription = await pricingService.getUserSubscription(userId);
    const currentPlan = PRICING_PLANS[currentSubscription.plan_id];
    
    if (!currentPlan) {
      return res.status(400).json({ error: 'Current plan not found' });
    }

    // Calculate add-on adjustments using the same logic as upgrade/downgrade
    const addonAdjustments = pricingService.calculateUpgradeDowngradeAdjustments(currentPlan, newPlan, currentSubscription);
    
    const priceDifference = newPlan.price - currentPlan.price;
    const netCost = priceDifference - addonAdjustments.totalCreditsEuros;
    
    res.json({
      success: true,
      preview: {
        current_plan: {
          id: currentPlan.id,
          name: currentPlan.name,
          price: currentPlan.price
        },
        new_plan: {
          id: newPlan.id,
          name: newPlan.name,
          price: newPlan.price
        },
        pricing: {
          base_price_difference: priceDifference,
          addon_credits: addonAdjustments.totalCreditsEuros,
          net_monthly_cost_change: netCost
        },
        addon_adjustments: addonAdjustments,
        has_credits: addonAdjustments.totalCreditsEuros > 0
      }
    });
  } catch (error) {
    console.error('Error previewing upgrade:', error);
    res.status(500).json({ error: 'Failed to preview upgrade' });
  }
});

/**
 * Upgrade user subscription
 */
router.post('/upgrade', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const userId = req.userId!;
    const { planId, stripeSubscriptionId } = req.body;
    const pricingService = req.pricingService!;
    
    if (!planId || !PRICING_PLANS[planId]) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }
    
    const plan = PRICING_PLANS[planId];
    if (plan.status !== 'active') {
      return res.status(400).json({ error: 'Plan is not available' });
    }

    // Check if user can downgrade to this plan (validate current usage)
    const currentSubscription = await pricingService.getUserSubscription(userId);
    const currentPlan = PRICING_PLANS[currentSubscription.plan_id];
    
    // If downgrading, check if current usage fits within new plan limits
    if (currentPlan && isDowngrade(currentPlan, plan)) {
      const validationResult = await validateDowngrade(currentSubscription, plan);
      if (!validationResult.allowed) {
        return res.status(400).json({ 
          error: 'Cannot downgrade to this plan',
          message: validationResult.reason,
          type: 'USAGE_EXCEEDS_LIMITS',
          current_usage: validationResult.currentUsage,
          plan_limits: plan.limits,
          max_limits: validationResult.newPlanMaxLimits
        });
      }
    }

    // Development mode: simulate payment without Stripe
    const isDev = process.env.NODE_ENV === 'development';
    let subscriptionId = stripeSubscriptionId;

    if (isDev && !subscriptionId) {
      // Generate a mock subscription ID for development
      subscriptionId = `dev_sub_${Date.now()}_${userId.slice(0, 8)}`;
    }
    
    // Calculate add-on adjustments for upgrade/downgrade
    const addonAdjustments = currentPlan ? pricingService.calculateUpgradeDowngradeAdjustments(currentPlan, plan, currentSubscription) : null;

    await pricingService.upgradeSubscription(userId, planId, subscriptionId);
    
    let message = `Successfully upgraded to ${plan.name} plan`;
    if (addonAdjustments && addonAdjustments.totalCreditsEuros > 0) {
      message += `. €${addonAdjustments.totalCreditsEuros} credit applied for unused add-ons`;
    }
    
    res.json({ 
      success: true, 
      message: message,
      plan: plan,
      dev_mode: isDev,
      subscription_id: subscriptionId,
      credits_applied: addonAdjustments ? addonAdjustments.totalCreditsEuros : 0,
      addon_adjustments: addonAdjustments
    });
  } catch (error) {
    console.error('Error upgrading subscription:', error);
    res.status(500).json({ error: 'Failed to upgrade subscription' });
  }
});

/**
 * Cancel user subscription
 */
router.post('/cancel', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const userId = req.userId!;
    const pricingService = req.pricingService!;
    
    await pricingService.cancelSubscription(userId);
    
    res.json({ 
      success: true, 
      message: 'Subscription canceled successfully'
    });
  } catch (error) {
    console.error('Error canceling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

/**
 * Get usage statistics and analytics
 */
router.get('/usage', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const userId = req.userId!;
    const pricingService = req.pricingService!;
    
    const analytics = await pricingService.getUsageAnalytics(userId);
    
    res.json(analytics);
  } catch (error) {
    console.error('Error fetching usage analytics:', error);
    res.status(500).json({ error: 'Failed to fetch usage analytics' });
  }
});

/**
 * Update AI credits usage - DEPRECATED
 * AI credits are now consumed via the pricingService.consumeAICredits() method
 * which is called automatically by AI routes (storyboards, documents, etc.)
 */
router.post('/usage/ai-credits', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  res.status(501).json({
    error: 'This endpoint has been deprecated. AI credits are now consumed automatically by AI routes.'
  });
});

// NOTE: Stripe webhook is handled at /api/billing/stripe-webhook (see billing.ts)
// That endpoint properly verifies signatures via stripeService.constructWebhookEvent()

/**
 * Get billing history from Stripe directly
 */
router.get('/billing/history', requireAuth, extractUserId, async (req: PricingRequest, res) => {
  try {
    const userId = req.userId!;

    // Get user's Stripe customer ID
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (userError || !user?.stripe_customer_id) {
      return res.json({ events: [] }); // No billing history if no customer
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    // Fetch ALL invoices - they contain all payment information
    // Stripe API limits to 100 per request, so we need to paginate
    let allInvoices: any[] = [];
    let hasMore = true;
    let startingAfter = undefined;

    while (hasMore) {
      const invoicesBatch = await stripe.invoices.list({
        customer: user.stripe_customer_id,
        limit: 100,
        starting_after: startingAfter,
        // No status filter - we want all invoices (draft, open, paid, void, uncollectible)
      });

      allInvoices = allInvoices.concat(invoicesBatch.data);
      hasMore = invoicesBatch.has_more;

      if (hasMore && invoicesBatch.data.length > 0) {
        startingAfter = invoicesBatch.data[invoicesBatch.data.length - 1].id;
      }
    }

    const invoices = { data: allInvoices };

    const events: any[] = [];

    // Process invoices - they contain all billing information
    invoices.data.forEach((invoice: any) => {
      const isRefund = invoice.total < 0;
      const amount = Math.abs(invoice.total);

      // Detect addon changes by checking for prorated charges (mid-cycle changes)
      // Regular renewals with addons should still be "payment_succeeded"
      const lineItems = invoice.lines?.data || [];
      const hasProrations = lineItems.some((item: any) =>
        item.description?.toLowerCase().includes('prorated') ||
        item.proration === true
      );

      // Build detailed description from line items
      let description = '';
      if (lineItems.length > 0) {
        const descriptions = lineItems
          .filter((item: any) => item.amount !== 0)
          .map((item: any) => {
            const itemAmount = Math.abs(item.amount);
            const sign = item.amount < 0 ? 'Credit' : 'Charge';
            return `${item.description || 'Subscription'} (${sign}: €${(itemAmount / 100).toFixed(2)})`;
          });
        description = descriptions.join(', ') || (isRefund ? 'Refund/Credit' : 'Subscription charge');
      } else {
        description = isRefund ? 'Refund/Credit' : 'Subscription charge';
      }

      let eventType = 'payment_succeeded';
      if (invoice.status === 'void' || invoice.status === 'uncollectible') {
        eventType = 'payment_failed';
      } else if (invoice.status === 'draft' || invoice.status === 'open') {
        eventType = 'payment_pending'; // New type for pending payments
      } else if (isRefund) {
        eventType = 'refund_issued';
      } else if (hasProrations) {
        eventType = 'subscription_updated';
      }

      events.push({
        id: invoice.id,
        event_type: eventType,
        metadata: {
          amount: amount,
          currency: invoice.currency.toUpperCase(),
          plan_id: invoice.subscription?.items?.data?.[0]?.price?.lookup_key || 'unknown',
          billing_period_start: invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null,
          billing_period_end: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
          invoice_number: invoice.number,
          invoice_pdf: invoice.invoice_pdf,
          is_refund: isRefund,
          has_prorations: hasProrations,
          description: description,
          status: invoice.status,
          line_items: lineItems.map((item: any) => ({
            description: item.description,
            amount: item.amount,
            quantity: item.quantity
          }))
        },
        created_at: new Date(invoice.created * 1000).toISOString(),
        stripe_event_id: invoice.id
      });
    });

    // Sort events by date (newest first)
    events.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    res.json({ events });
  } catch (error) {
    console.error('Error fetching billing history from Stripe:', error);
    res.status(500).json({ error: 'Failed to fetch billing history' });
  }
});

// Dev payment endpoints removed (S4 security fix) - use Stripe test mode for dev testing
// Removed: /dev/create-payment-session, /dev/payment-success, /dev/reset-to-free
/* eslint-disable @typescript-eslint/no-unused-vars */
const _devEndpointsRemoved = true; // placeholder to keep the file valid if nothing follows

export default router;