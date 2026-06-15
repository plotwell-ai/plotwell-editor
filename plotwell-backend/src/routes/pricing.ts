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

// Dev payment endpoints removed (S4 security fix) - use Stripe test mode for dev testing
// Removed: /dev/create-payment-session, /dev/payment-success, /dev/reset-to-free
/* eslint-disable @typescript-eslint/no-unused-vars */
const _devEndpointsRemoved = true; // placeholder to keep the file valid if nothing follows

export default router;