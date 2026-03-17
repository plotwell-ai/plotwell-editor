import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth';
import { PricingService } from '../services/pricingService';
// Note: MonthlyBillingService has been removed - replaced with unified billing system
import { PRICING_PLANS, getPlanById, getAddonStripePriceId, currentPriceIds } from '../config/pricingPlans';
import Stripe from 'stripe';

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-08-27.basil',
});
import { stripeService } from '../services/stripeService';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const pricingService = new PricingService(supabase);
// Note: monthlyBillingService has been removed

// Helper function to get user ID from request
function getUserId(req: any): string | null {
  return req.user?.sub || req.user?.id || null;
}

/**
 * Get user profile/authentication status
 * Replaces direct Supabase auth calls from the frontend
 */
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User ID not found' });
    }

    // Get user data from Supabase auth
    const { data: user, error: userError } = await supabase.auth.admin.getUserById(userId);
    
    if (userError) {
      console.error('Error fetching user:', userError);
      return res.status(500).json({ success: false, error: 'Failed to fetch user data' });
    }

    // Return user profile data
    res.json({
      success: true,
      user: {
        id: user.user.id,
        email: user.user.email,
        created_at: user.user.created_at,
        last_sign_in_at: user.user.last_sign_in_at,
        app_metadata: user.user.app_metadata,
        user_metadata: user.user.user_metadata
      }
    });
  } catch (error) {
    console.error('Error in /profile endpoint:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Get user's current subscription and usage data
 * Replaces direct Supabase calls from the frontend
 */
router.get('/subscription', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Use PricingService to get accurate subscription data including collaborator count
    const response = await pricingService.getUserSubscription(userId);

    // If the user shows as free plan but might have a Stripe subscription, try to sync
    if (response.plan_id === 'free') {
      try {
        // Check if user has Stripe subscription that wasn't synced
        const { data: userData } = await supabase
          .from('users')
          .select('stripe_customer_id, stripe_subscription_id')
          .eq('id', userId)
          .single();

        if (userData?.stripe_subscription_id) {
          // Use the fix-subscription endpoint logic to sync
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
          const subscription = await stripe.subscriptions.retrieve(userData.stripe_subscription_id, {
            expand: ['items.data.price']
          });

          if (subscription.status === 'active') {
            // Extract plan from subscription
            const priceId = subscription.items.data[0].price.id;
            let planId = 'paid'; // Default for new simplified model

            // Get period timestamps from subscription items (not top-level subscription)
            const subscriptionItem = subscription.items.data[0];
            const currentPeriodStart = subscriptionItem.current_period_start;
            const currentPeriodEnd = subscriptionItem.current_period_end;

            const dataToUpsert = {
              user_id: userId,
              plan_id: planId,
              status: subscription.status,
              stripe_subscription_id: subscription.id,
              current_period_start: currentPeriodStart ? new Date(currentPeriodStart * 1000).toISOString() : null,
              current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
              cancel_at_period_end: subscription.cancel_at_period_end || false,
              plan_price: subscription.plan?.amount || 900,
              plan_currency: subscription.currency || 'eur',
              updated_at: new Date().toISOString()
            };

            // Update user subscription
            const { error: upsertError } = await supabase
              .from('user_subscriptions')
              .upsert(dataToUpsert, { onConflict: 'user_id' });

            if (!upsertError) {
              // Re-fetch the updated subscription
              const updatedResponse = await pricingService.getUserSubscription(userId);
              res.json({
                success: true,
                subscription: updatedResponse,
                synced: true
              });
              return;
            }
          }
        }
      } catch (syncError) {
        console.error('Error syncing subscription:', syncError);
        // Continue with original response if sync fails
      }
    }

    res.json({
      success: true,
      subscription: response
    });

  } catch (error) {
    console.error('Error fetching user subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription data' });
  }
});

/**
 * Get available addon pricing for user's current plan
 */
router.get('/subscription/addons', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Get user's current subscription from database (including cancellation info)
    const { data: subscriptionData } = await supabase
      .from('user_subscriptions')
      .select('plan_id, additional_projects, additional_collaborators, status, cancel_at_period_end, current_period_end, stripe_subscription_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    const planId = subscriptionData?.plan_id || 'free';
    const plan = getPlanById(planId);

    if (!plan || !plan.addons) {
      return res.json({
        success: true,
        available_addons: [],
        plan_id: planId,
        subscription_status: subscriptionData?.status || 'active',
        cancel_at_period_end: subscriptionData?.cancel_at_period_end || false,
        current_period_end: subscriptionData?.current_period_end || null,
        message: `No addons available for current plan: ${planId}`
      });
    }

    // Detect billing cycle from Stripe subscription
    let billingCycle: 'monthly' | 'yearly' = 'monthly';
    if (subscriptionData?.stripe_subscription_id) {
      try {
        const subscription = await stripeClient.subscriptions.retrieve(subscriptionData.stripe_subscription_id, {
          expand: ['items.data.price']
        });
        const basePriceItem = subscription.items.data.find((item: any) => {
          const priceId = item.price.id;
          return priceId === currentPriceIds.paid_monthly || priceId === currentPriceIds.paid_yearly;
        });
        if (basePriceItem?.price.recurring?.interval === 'year') {
          billingCycle = 'yearly';
        }
      } catch (err) {
        console.error('⚠️ Error detecting billing cycle for addons:', err);
      }
    }

    const addons = [];

    // Projects addon
    if (plan.addons.additionalProjects?.enabled) {
      addons.push({
        type: 'additional_projects',
        name: 'Additional Projects',
        description: 'Add more active projects to your subscription',
        price_per_unit: billingCycle === 'yearly'
          ? plan.addons.additionalProjects.yearlyPricePerProject
          : plan.addons.additionalProjects.pricePerProject,
        price_per_unit_monthly: plan.addons.additionalProjects.pricePerProject,
        price_per_unit_yearly: plan.addons.additionalProjects.yearlyPricePerProject,
        currency: plan.addons.additionalProjects.currency,
        max_additional: plan.addons.additionalProjects.maxAdditional || -1,
        current_quantity: subscriptionData?.additional_projects || 0
      });
    }

    // Collaborators addon
    if (plan.addons.additionalCollaborators?.enabled) {
      addons.push({
        type: 'additional_collaborators',
        name: 'Additional Collaborators',
        description: 'Add more team members to your projects',
        price_per_unit: billingCycle === 'yearly'
          ? plan.addons.additionalCollaborators.yearlyPricePerCollaborator
          : plan.addons.additionalCollaborators.pricePerCollaborator,
        price_per_unit_monthly: plan.addons.additionalCollaborators.pricePerCollaborator,
        price_per_unit_yearly: plan.addons.additionalCollaborators.yearlyPricePerCollaborator,
        currency: plan.addons.additionalCollaborators.currency,
        max_additional: plan.addons.additionalCollaborators.maxAdditional || -1,
        current_quantity: subscriptionData?.additional_collaborators || 0
      });
    }

    res.json({
      success: true,
      plan_id: planId,
      billing_cycle: billingCycle,
      subscription_status: subscriptionData?.status || 'active',
      cancel_at_period_end: subscriptionData?.cancel_at_period_end || false,
      current_period_end: subscriptionData?.current_period_end || null,
      available_addons: addons
    });

  } catch (error) {
    console.error('Error fetching addon pricing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Purchase addon (projects or collaborators)
 */
/**
 * Create Stripe checkout session for addon purchase
 */
router.post('/subscription/addons/checkout', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { addon_type, quantity } = req.body;

    // Validate input
    if (!addon_type || !quantity) {
      return res.status(400).json({ error: 'addon_type and quantity are required' });
    }

    if (!['additional_projects', 'additional_collaborators'].includes(addon_type)) {
      return res.status(400).json({ error: 'Invalid addon type' });
    }

    if (quantity < 1 || quantity > 100) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 100' });
    }

    // Get user's current subscription and plan
    const { data: subscriptionData } = await supabase
      .from('user_subscriptions')
      .select('plan_id, additional_projects, additional_collaborators')
      .eq('user_id', userId)
      .single();

    const planId = subscriptionData?.plan_id || 'free';
    const plan = getPlanById(planId);

    if (!plan || !plan.addons) {
      return res.status(400).json({ error: 'Addons not available for current plan' });
    }

    // Check if addon is enabled for this plan
    const addonConfig = addon_type === 'additional_projects' 
      ? plan.addons.additionalProjects 
      : plan.addons.additionalCollaborators;

    if (!addonConfig || !addonConfig.enabled) {
      return res.status(400).json({ error: `${addon_type} addon not available for ${planId} plan` });
    }

    // Get Stripe price ID for the addon
    const stripePriceId = getAddonStripePriceId(planId, addon_type);
    if (!stripePriceId) {
      return res.status(400).json({ error: 'Stripe price not configured for this addon' });
    }

    // Create checkout session with Stripe
    const session = await stripeService.createCheckoutSession(userId, stripePriceId, {
      addon_type,
      quantity: quantity.toString(),
      plan_id: planId
    });

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url,
      addon_type,
      quantity,
      unit_price: addon_type === 'additional_projects' 
        ? (addonConfig as any)?.pricePerProject || 0
        : (addonConfig as any)?.pricePerCollaborator || 0
    });

  } catch (error) {
    console.error('Error creating addon checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * Create Stripe Checkout session for addon purchase
 * Redirects user to Stripe Checkout for secure payment processing
 * NOTE: This endpoint has been deprecated - use unified billing system instead
 */
// router.post('/subscription/addons/purchase', requireAuth, async (req, res) => {
router.post('/subscription/addons/purchase', requireAuth, async (req, res) => {
  res.status(501).json({
    error: 'This endpoint has been deprecated. Please use the unified billing system at /api/billing endpoints.'
  });
});

/*
// DEPRECATED: This endpoint code has been commented out - use unified billing system instead

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { addon_type, quantity } = req.body;

    // Validate input
    if (!addon_type || !quantity) {
      return res.status(400).json({ error: 'addon_type and quantity are required' });
    }

    if (!['additional_projects', 'additional_collaborators'].includes(addon_type)) {
      return res.status(400).json({ error: 'Invalid addon type' });
    }

    if (quantity < 1 || quantity > 100) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 100' });
    }

    // Get user's current subscription and plan with Stripe data
    const { data: subscriptionData } = await supabase
      .from('user_subscriptions')
      .select('plan_id, additional_projects, additional_collaborators')
      .eq('user_id', userId)
      .single();

    const { data: userData } = await supabase
      .from('users')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('id', userId)
      .single();

    if (!userData?.stripe_customer_id || !userData?.stripe_subscription_id) {
      return res.status(400).json({
        error: 'No active Stripe subscription found. Please upgrade to Pro first.'
      });
    }

    const planId = subscriptionData?.plan_id || 'free';
    const plan = getPlanById(planId);

    if (!plan || !plan.addons) {
      return res.status(400).json({ error: 'Addons not available for current plan' });
    }

    // Check if addon is enabled for this plan
    const addonConfig = addon_type === 'additional_projects' 
      ? plan.addons.additionalProjects 
      : plan.addons.additionalCollaborators;

    if (!addonConfig || !addonConfig.enabled) {
      return res.status(400).json({ error: `${addon_type} addon not available for ${planId} plan` });
    }

    // Check max additional limit
    const currentAdditional = addon_type === 'additional_projects' 
      ? subscriptionData?.additional_projects || 0 
      : subscriptionData?.additional_collaborators || 0;

    const maxAdditional = addon_type === 'additional_projects'
      ? plan.addons?.additionalProjects?.maxAdditional
      : plan.addons?.additionalCollaborators?.maxAdditional;

    if (maxAdditional && maxAdditional !== -1) {
      if (currentAdditional + quantity > maxAdditional) {
        return res.status(400).json({ 
          error: `Would exceed maximum additional limit of ${maxAdditional}`,
          current_additional: currentAdditional,
          max_additional: maxAdditional
        });
      }
    }

    // Initialize AddonBillingService and add addon to subscription
    const { AddonBillingService } = await import('../services/addonBillingService');
    const addonBillingService = new AddonBillingService(supabase);

    // Map addon_type to our service types
    const serviceAddonType = addon_type === 'additional_projects' ? 'projects' : 'collaborators';

    // Get return URL for checkout success/cancel
    const returnUrl = req.body.return_url || `${process.env.FRONTEND_URL?.split(',')[0] || 'http://localhost:5173'}/profile`;

    // Create Stripe Checkout session for addon
    const checkoutResult = await addonBillingService.createAddonCheckoutSession({
      userId,
      addonType: serviceAddonType,
      quantity
    }, returnUrl);

    if (!checkoutResult.success || !checkoutResult.checkout_url) {
      return res.status(400).json({ 
        error: 'Failed to create checkout session for addon. Please try again or contact support.',
        details: 'Stripe checkout creation failed'
      });
    }

    res.json({
      success: true,
      checkout_url: checkoutResult.checkout_url,
      session_id: checkoutResult.session_id,
      message: `Redirecting to secure checkout for ${quantity} ${addon_type.replace('_', ' ')}`,
      addon_info: {
        type: addon_type,
        quantity: quantity,
        current_additional: currentAdditional
      }
    });

  } catch (error) {
    console.error('Error purchasing addon:', error);
    res.status(500).json({ error: 'Internal server error' });
  }

*/
// END DEPRECATED CODE

/**
 * Get user's addon transaction history
 */
router.get('/subscription/addons/transactions', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { data: transactions, error } = await supabase
      .from('addon_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching addon transactions:', error);
      return res.status(500).json({ error: 'Failed to fetch transactions' });
    }

    // Format transactions for response
    const formattedTransactions = transactions.map(tx => ({
      id: tx.id,
      addon_type: tx.addon_type,
      quantity: tx.quantity,
      unit_price: tx.unit_price_cents / 100,
      total_price: tx.total_price_cents / 100,
      currency: tx.currency,
      status: tx.status,
      created_at: tx.created_at,
      processed_at: tx.processed_at
    }));

    res.json({
      success: true,
      transactions: formattedTransactions
    });

  } catch (error) {
    console.error('Error fetching addon transactions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Get user's effective subscription limits (including addons)
 */
router.get('/subscription/limits', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Use PricingService instead of database function for more reliable results
    const pricingService = new PricingService(supabase);
    const subscription = await pricingService.getUserSubscription(userId);
    const plan = pricingService.getPlan(subscription.plan_id);

    if (!plan) {
      return res.status(500).json({ error: 'Invalid subscription plan' });
    }

    // Get current usage counts from subscription (which queries the database)
    const currentSubscription = await pricingService.getUserSubscription(userId);
    const projectsCount = currentSubscription.projects_count || 0;
    const collaboratorsCount = currentSubscription.collaborators_count || 0;

    // Get effective limits including addons
    // Note: AI credits are now one-time purchases, not part of subscription limits
    const effectiveLimits = pricingService.getEffectiveLimits(
      plan,
      subscription.additional_projects || 0,
      subscription.additional_collaborators || 0
    );

    const result = {
      success: true,
      plan_id: subscription.plan_id,
      projects_used: projectsCount,
      collaborators_used: collaboratorsCount,
      projects: effectiveLimits.projects === -1 ? 'Unlimited' : effectiveLimits.projects,
      collaborators: effectiveLimits.collaborators === -1 ? 'Unlimited' : effectiveLimits.collaborators,
      limits: {
        projects: {
          base: plan.limits.projects,
          additional: subscription.additional_projects || 0,
          effective: effectiveLimits.projects
        },
        collaborators: {
          base: plan.limits.collaborators,
          additional: subscription.additional_collaborators || 0,
          effective: effectiveLimits.collaborators
        }
        // Note: AI credits are now one-time purchases via /api/ai-credits
        // Balance is tracked in user_quotas.ai_credits_balance
      }
    };

    res.json(result);

  } catch (error) {
    console.error('❌ Error fetching subscription limits:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Reduce addons (remove projects or collaborators)
 */
router.post('/subscription/addons/reduce', requireAuth, async (req, res) => {
  try {

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { addon_type, quantity } = req.body;

    // Basic validation
    if (!addon_type || !quantity) {
      return res.status(400).json({ error: 'addon_type and quantity are required' });
    }

    if (!['additional_projects', 'additional_collaborators'].includes(addon_type)) {
      return res.status(400).json({ error: 'Invalid addon type' });
    }

    // Get current subscription data for context
    const { data: subscriptionData } = await supabase
      .from('user_subscriptions')
      .select('plan_id, additional_projects, additional_collaborators')
      .eq('user_id', userId)
      .single();

    const currentAdditional = addon_type === 'additional_projects' 
      ? subscriptionData?.additional_projects || 0 
      : subscriptionData?.additional_collaborators || 0;

    if (currentAdditional < quantity) {
      return res.status(400).json({ 
        error: `Cannot reduce by ${quantity}, only ${currentAdditional} additional ${addon_type.replace('_', ' ')} available to remove`,
        current_additional: currentAdditional
      });
    }

    // Import StripeService and redirect to Customer Portal
    // The Customer Portal shows proration and allows subscription modifications
    const { stripeService } = await import('../services/stripeService');
    const portalSession = await stripeService.createPortalSession(userId);

    res.json({
      success: true,
      portal_url: portalSession.url,
      message: `Redirecting to Stripe Customer Portal to manage your ${addon_type.replace('_', ' ')} subscription. You'll see proration amounts and can modify your subscription safely.`,
      addon_info: {
        type: addon_type,
        current_quantity: currentAdditional,
        requested_reduction: quantity,
        note: 'Use the Customer Portal to modify quantities with full proration preview'
      }
    });

  } catch (error) {
    console.error('Error creating portal session for addon reduction:', error);
    res.status(500).json({ error: 'Failed to open billing portal for addon management' });
  }
});

/**
 * Get specific user's subscription (for collaboration access checks)
 * Only accessible if requester has collaboration access to user's projects
 */
router.get('/subscription/:userId', requireAuth, async (req, res) => {
  try {
    const requesterId = getUserId(req);
    const { userId } = req.params;
    
    if (!requesterId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Check if requester has collaboration access to this user's projects
    // This is a security check to prevent unauthorized subscription access
    const { data: collaborations, error: collabError } = await supabase
      .from('project_collaborators')
      .select('project_id, projects!inner(user_id)')
      .eq('user_id', requesterId)
      .eq('projects.user_id', userId)
      .eq('status', 'active')
      .limit(1);

    if (collabError || !collaborations || collaborations.length === 0) {
      return res.status(403).json({ error: 'Access denied - not a collaborator' });
    }

    // Only return minimal info needed for collaboration access checks
    // Do not expose project counts or detailed subscription status
    const { data: subscriptionData } = await supabase
      .from('user_subscriptions')
      .select('plan_id')
      .eq('user_id', userId)
      .single();

    res.json({
      plan_id: subscriptionData?.plan_id || 'free'
    });

  } catch (error) {
    console.error('Error fetching user subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription data' });
  }
});

/**
 * Sync user subscription with Stripe (manual fix for mismatched subscriptions)
 */
router.post('/subscription/sync', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Check if user has Stripe data
    const { data: userData } = await supabase
      .from('users')
      .select('stripe_customer_id, stripe_subscription_id, email')
      .eq('id', userId)
      .single();

    if (!userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    // If no subscription ID, look for customer and active subscriptions
    if (!userData.stripe_subscription_id) {

      const customers = await stripe.customers.list({
        email: userData.email,
        limit: 10
      });

      if (customers.data.length === 0) {
        return res.json({
          success: false,
          message: 'No Stripe customer found for this user',
          current_plan: 'free'
        });
      }

      const customer = customers.data[0];
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 10
      });

      if (subscriptions.data.length === 0) {
        return res.json({
          success: false,
          message: 'No active subscriptions found',
          current_plan: 'free'
        });
      }

      const subscription = subscriptions.data[0];

      // Update users table with Stripe IDs
      await supabase
        .from('users')
        .update({
          stripe_customer_id: customer.id,
          stripe_subscription_id: subscription.id
        })
        .eq('id', userId);

      userData.stripe_customer_id = customer.id;
      userData.stripe_subscription_id = subscription.id;
    }

    // Now sync the subscription
    if (userData.stripe_subscription_id) {
      const subscription = await stripe.subscriptions.retrieve(userData.stripe_subscription_id);

      if (subscription.status === 'active') {
        const priceId = subscription.items.data[0]?.price?.id;
        const planId = 'paid'; // New simplified model

        // Update user_subscriptions table
        const { error: upsertError } = await supabase
          .from('user_subscriptions')
          .upsert({
            user_id: userId,
            plan_id: planId,
            status: subscription.status,
            stripe_subscription_id: subscription.id,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            cancel_at_period_end: subscription.cancel_at_period_end || false,
            additional_projects: 0, // Reset to 0, will be updated based on addon subscriptions
            additional_collaborators: 0,
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id' });

        if (upsertError) {
          console.error('❌ Error updating subscription:', upsertError);
          return res.status(500).json({ error: 'Failed to update subscription' });
        }

        // Update user_subscriptions table with synced data
        await supabase
          .from('user_subscriptions')
          .upsert({
            user_id: userId,
            plan_id: planId,
            status: subscription.status,
            updated_at: new Date().toISOString()
          });

        res.json({
          success: true,
          message: `Subscription synced to ${planId} plan`,
          subscription_id: subscription.id,
          plan_id: planId,
          status: subscription.status,
          synced_at: new Date().toISOString()
        });
      } else {
        res.json({
          success: false,
          message: `Subscription status is ${subscription.status}, not active`,
          subscription_status: subscription.status
        });
      }
    } else {
      res.json({
        success: false,
        message: 'No Stripe subscription found to sync'
      });
    }

  } catch (error: any) {
    console.error('❌ SYNC SUBSCRIPTION ERROR:', error);
    res.status(500).json({ error: 'Failed to sync subscription' });
  }
});

/**
 * Initialize user subscription if it doesn't exist
 * Creates default free plan subscription and quotas
 */
router.post('/subscription/init', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Create subscription and quota records
    const { error: subError } = await supabase
      .from('user_subscriptions')
      .upsert({
        user_id: userId,
        plan_id: 'free',
        status: 'active'
      }, { onConflict: 'user_id' });

    if (subError) {
      console.error('Error creating subscription:', subError);
      return res.status(500).json({ error: 'Failed to create subscription' });
    }

    const { error: quotaError } = await supabase
      .from('user_quotas')
      .upsert({
        user_id: userId,
        ai_generations_used: 0,
        ai_credits_balance: 0,
        storage_used_gb: 0
      }, { onConflict: 'user_id' });

    if (quotaError) {
      console.error('Error creating quotas:', quotaError);
      return res.status(500).json({ error: 'Failed to create quotas' });
    }

    res.json({
      success: true,
      message: 'Subscription initialized successfully',
      subscription: {
        plan_id: 'free',
        subscription_status: 'active',
        projects_count: 0,
        ai_generations_used: 0,
        ai_credits_balance: 0,
        storage_used_gb: 0,
        collaborators_count: 0,
      }
    });

  } catch (error) {
    console.error('Error initializing user subscription:', error);
    res.status(500).json({ error: 'Failed to initialize subscription' });
  }
});

/**
 * Update user profile (display name)
 */
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { full_name } = req.body;

    // Validate input
    if (full_name !== undefined && typeof full_name !== 'string') {
      return res.status(400).json({ error: 'full_name must be a string' });
    }

    // Prepare update object
    const updateData: { full_name?: string; updated_at: string } = {
      updated_at: new Date().toISOString()
    };

    if (full_name !== undefined) {
      updateData.full_name = full_name.trim();
    }

    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select('id, email, full_name, ui_language')
      .single();

    if (error) {
      console.error('❌ USER PROFILE UPDATE ERROR:', error);
      return res.status(500).json({ error: 'Failed to update user profile' });
    }

    res.json({
      success: true,
      user: data
    });
  } catch (error) {
    console.error('Error in PUT /profile endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/user/marketing-consent
 * Update marketing email consent (GDPR-compliant with timestamp)
 */
router.put('/marketing-consent', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { consent } = req.body;
    if (typeof consent !== 'boolean') {
      return res.status(400).json({ error: 'consent must be a boolean' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        marketing_consent: consent,
        marketing_consent_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('id, marketing_consent, marketing_consent_at')
      .single();

    if (error) {
      console.error('❌ MARKETING CONSENT UPDATE ERROR:', error);
      return res.status(500).json({ error: 'Failed to update marketing consent' });
    }

    console.log(`📧 Marketing consent ${consent ? 'granted' : 'revoked'} for user ${userId}`);
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error in PUT /marketing-consent:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Get user's UI language preference
 */
router.get('/ui-language', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { data: userData, error } = await supabase
      .from('users')
      .select('ui_language')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Error fetching user language:', error);
      return res.status(500).json({ error: 'Failed to fetch user language preference' });
    }

    res.json({
      success: true,
      ui_language: userData?.ui_language || 'en'
    });
  } catch (error) {
    console.error('Error in /ui-language endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Update user's UI language preference
 */
router.put('/ui-language', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { ui_language } = req.body;
    
    // Validate language code
    const supportedLanguages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'zh', 'hi', 'ar', 'ko'];
    if (!supportedLanguages.includes(ui_language)) {
      return res.status(400).json({ 
        error: 'Invalid language code',
        supported_languages: supportedLanguages
      });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ ui_language })
      .eq('id', userId)
      .select('ui_language')
      .single();

    if (error) {
      console.error('❌ USER LANGUAGE UPDATE ERROR:', error);
      return res.status(500).json({ error: 'Failed to update user language preference' });
    }

    res.json({
      success: true,
      ui_language: data.ui_language
    });
  } catch (error) {
    console.error('Error in PUT /ui-language endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Get complete billing overview with transparent view of costs and limits
 */
router.get('/billing/overview', requireAuth, async (req, res) => {
  res.status(501).json({
    error: 'This endpoint has been deprecated. Please use the unified billing system at /api/billing endpoints.'
  });
});

/**
 * Get monthly billing summary for current billing cycle - DEPRECATED
 */
router.get('/billing/monthly-summary', requireAuth, async (req, res) => {
  res.status(501).json({
    error: 'This endpoint has been deprecated. Please use the unified billing system at /api/billing endpoints.'
  });
});


/**
 * Check if user can create a new project (monthly billing logic)
 */
router.get('/billing/can-create-project', requireAuth, async (req, res) => {
  res.status(501).json({
    error: 'This endpoint has been deprecated. Please use the unified billing system at /api/billing endpoints.'
  });
});

/**
 * Get billing cycle information
 */
router.get('/billing/cycle-info', requireAuth, async (req, res) => {
  res.status(501).json({
    error: 'This endpoint has been deprecated. Please use the unified billing system at /api/billing endpoints.'
  });
});

/**
 * Process monthly billing (admin/system use)
 */
router.post('/billing/process-monthly', requireAuth, async (req, res) => {
  res.status(501).json({
    error: 'This endpoint has been deprecated. Please use the unified billing system at /api/billing endpoints.'
  });
});

/**
 * Get projects tour completion status
 */
router.get('/projects-tour', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { data: userData, error } = await supabase
      .from('users')
      .select('projects_tour_completed_at')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Error fetching projects tour status:', error);
      return res.status(500).json({ error: 'Failed to fetch projects tour status' });
    }

    res.json({
      success: true,
      completed: !!userData?.projects_tour_completed_at,
      completed_at: userData?.projects_tour_completed_at || null
    });
  } catch (error) {
    console.error('Error in /projects-tour endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Mark projects tour as completed
 */
router.post('/projects-tour/complete', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Only update if not already completed
    const { data, error } = await supabase
      .from('users')
      .update({ projects_tour_completed_at: new Date().toISOString() })
      .eq('id', userId)
      .is('projects_tour_completed_at', null)
      .select('id, projects_tour_completed_at')
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned (already completed)
      console.error('Error marking projects tour complete:', error);
      return res.status(500).json({ error: 'Failed to mark projects tour complete' });
    }

    res.json({
      success: true,
      message: data ? 'Projects tour marked as complete' : 'Projects tour was already completed',
      completed_at: data?.projects_tour_completed_at || null
    });
  } catch (error) {
    console.error('Error in /projects-tour/complete endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Delete user account permanently
 * This will:
 * 1. Cancel any active Stripe subscriptions
 * 2. Delete all user data from public tables (CASCADE will handle related data)
 * 3. Delete the user from Supabase auth
 */
router.delete('/delete-account', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    console.log('🗑️ DELETE ACCOUNT REQUEST for user:', userId);

    // Get user's Stripe data before deletion
    const { data: userData, error: userFetchError } = await supabase
      .from('users')
      .select('stripe_customer_id, stripe_subscription_id, email')
      .eq('id', userId)
      .single();

    if (userFetchError) {
      console.error('❌ Error fetching user data:', userFetchError);
      // Continue anyway - user might not have public.users record
    }

    // Step 1: Cancel ALL Stripe subscriptions and delete customer
    // This uses the stripeService which properly handles:
    // - Cancelling all subscriptions (not just the one in our DB)
    // - Deleting the Stripe customer record to prevent future charges
    if (userData?.stripe_customer_id) {
      try {
        const stripeResult = await stripeService.deleteCustomerAndSubscriptions(userData.stripe_customer_id);
        console.log('✅ Stripe cleanup result:', {
          subscriptionsCancelled: stripeResult.subscriptionsCancelled,
          customerDeleted: stripeResult.customerDeleted,
          errors: stripeResult.errors.length > 0 ? stripeResult.errors : 'none'
        });
      } catch (stripeError: any) {
        console.error('⚠️ Error cleaning up Stripe data:', stripeError.message);
        // Continue with deletion even if Stripe cleanup fails
      }
    } else {
      console.log('ℹ️ No Stripe customer ID found, skipping Stripe cleanup');
    }

    // Step 2: Delete user data from public tables first
    // This handles foreign key relationships properly
    // Projects deletion will CASCADE to: scripts, characters, locations, documents, etc.
    const { error: projectsDeleteError } = await supabase
      .from('projects')
      .delete()
      .eq('user_id', userId);

    if (projectsDeleteError) {
      console.error('⚠️ Error deleting projects:', projectsDeleteError.message);
      // Continue - may not have projects
    } else {
      console.log('✅ User projects deleted');
    }

    // Delete user subscriptions
    const { error: subscriptionDeleteError } = await supabase
      .from('user_subscriptions')
      .delete()
      .eq('user_id', userId);

    if (subscriptionDeleteError) {
      console.error('⚠️ Error deleting user_subscriptions:', subscriptionDeleteError.message);
    }

    // Delete user quotas
    const { error: quotasDeleteError } = await supabase
      .from('user_quotas')
      .delete()
      .eq('user_id', userId);

    if (quotasDeleteError) {
      console.error('⚠️ Error deleting user_quotas:', quotasDeleteError.message);
    }

    // Delete addon transactions
    const { error: transactionsDeleteError } = await supabase
      .from('addon_transactions')
      .delete()
      .eq('user_id', userId);

    if (transactionsDeleteError) {
      console.error('⚠️ Error deleting addon_transactions:', transactionsDeleteError.message);
    }

    // Delete AI usage events
    const { error: aiUsageDeleteError } = await supabase
      .from('ai_usage_events')
      .delete()
      .eq('user_id', userId);

    if (aiUsageDeleteError) {
      console.error('⚠️ Error deleting ai_usage_events:', aiUsageDeleteError.message);
    }

    // Conversations are deleted via CASCADE when projects are deleted (conversations.project_id FK)
    // No need for explicit deletion here

    // Step 3: Delete from public.users table
    const { error: publicUserDeleteError } = await supabase
      .from('users')
      .delete()
      .eq('id', userId);

    if (publicUserDeleteError) {
      console.error('⚠️ Error deleting from public.users:', publicUserDeleteError.message);
      // This might fail if FK constraints exist - continue anyway
    } else {
      console.log('✅ Public user record deleted');
    }

    // Step 4: Delete user from Supabase Auth
    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(userId);

    if (authDeleteError) {
      console.error('❌ Error deleting from auth.users:', authDeleteError);
      return res.status(500).json({
        error: 'Failed to delete account from authentication system',
        details: authDeleteError.message
      });
    }

    console.log('✅ Account deleted successfully for user:', userId);

    res.json({
      success: true,
      message: 'Account deleted successfully'
    });

  } catch (error: any) {
    console.error('❌ DELETE ACCOUNT ERROR:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

/**
 * GDPR Data Export (Article 20 - Right to portability)
 * Returns all user-owned data as JSON
 */
router.get('/data-export', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found' });
    }

    // 1. User profile
    const { data: profile } = await supabase
      .from('users')
      .select('id, email, full_name, ui_language, created_at, updated_at')
      .eq('id', userId)
      .single();

    // 2. Subscription
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('plan_id, subscription_status, billing_cycle, current_period_start, current_period_end, additional_projects, additional_collaborators, created_at')
      .eq('user_id', userId)
      .single();

    // 3. Projects (owned by user)
    const { data: projects } = await supabase
      .from('projects')
      .select('id, name, description, project_type, status, title, author, based_on, contact_info, created_at, updated_at')
      .eq('user_id', userId);

    const projectIds = (projects || []).map(p => p.id);

    // 4. Scripts (for owned projects)
    const { data: scripts } = projectIds.length > 0
      ? await supabase
          .from('scripts')
          .select('id, project_id, episode_id, title, content, created_at, updated_at')
          .in('project_id', projectIds)
      : { data: [] };

    // 5. Characters (for owned projects)
    const { data: characters } = projectIds.length > 0
      ? await supabase
          .from('characters')
          .select('id, project_id, name, description, role, age, gender, arc, backstory, personality_traits, created_at')
          .in('project_id', projectIds)
      : { data: [] };

    // 6. Locations (for owned projects)
    const { data: locations } = projectIds.length > 0
      ? await supabase
          .from('locations')
          .select('id, project_id, name, description, type, significance, visual_notes, created_at')
          .in('project_id', projectIds)
      : { data: [] };

    // 7. Documents (for owned projects)
    const { data: documents } = projectIds.length > 0
      ? await supabase
          .from('project_documents')
          .select('id, project_id, title, content, document_type, created_at, updated_at')
          .in('project_id', projectIds)
      : { data: [] };

    // 8. Storyboard panels (for owned projects)
    const { data: storyboards } = projectIds.length > 0
      ? await supabase
          .from('storyboard_panels')
          .select('id, project_id, scene_id, panel_number, description, shot_type, camera_movement, notes, created_at')
          .in('project_id', projectIds)
      : { data: [] };

    // 9. Beats (for owned projects)
    const { data: beats } = projectIds.length > 0
      ? await supabase
          .from('beats')
          .select('id, project_id, title, description, act, sequence_order, created_at')
          .in('project_id', projectIds)
      : { data: [] };

    // 10. Conversations (for owned projects)
    const { data: conversations } = projectIds.length > 0
      ? await supabase
          .from('conversations')
          .select('id, project_id, title, created_at')
          .in('project_id', projectIds)
      : { data: [] };

    const conversationIds = (conversations || []).map(c => c.id);
    const { data: messages } = conversationIds.length > 0
      ? await supabase
          .from('conversation_messages')
          .select('id, conversation_id, role, content, created_at')
          .in('conversation_id', conversationIds)
      : { data: [] };

    // 11. Seasons & Episodes (for owned projects)
    const { data: seasons } = projectIds.length > 0
      ? await supabase
          .from('seasons')
          .select('id, project_id, season_number, title, created_at')
          .in('project_id', projectIds)
      : { data: [] };

    const { data: episodes } = projectIds.length > 0
      ? await supabase
          .from('episodes')
          .select('id, project_id, season_id, episode_number, title, status, created_at')
          .in('project_id', projectIds)
      : { data: [] };

    // 12. Comments by user
    const { data: comments } = await supabase
      .from('comments')
      .select('id, content_type, content_id, body, created_at')
      .eq('user_id', userId);

    // 13. AI usage summary
    const { data: aiUsage } = await supabase
      .from('ai_usage_events')
      .select('operation_type, model, prompt_tokens, completion_tokens, total_tokens, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(500);

    // 14. Billing events
    const { data: billingEvents } = await supabase
      .from('billing_events')
      .select('event_type, plan_id, amount, currency, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    const exportData = {
      export_date: new Date().toISOString(),
      export_format: 'plotwell-gdpr-export-v1',
      profile: profile || null,
      subscription: subscription || null,
      projects: projects || [],
      scripts: scripts || [],
      characters: characters || [],
      locations: locations || [],
      documents: documents || [],
      storyboards: storyboards || [],
      beats: beats || [],
      seasons: seasons || [],
      episodes: episodes || [],
      conversations: (conversations || []).map(c => ({
        ...c,
        messages: (messages || []).filter(m => m.conversation_id === c.id)
      })),
      comments: comments || [],
      ai_usage: aiUsage || [],
      billing_events: billingEvents || [],
    };

    res.setHeader('Content-Disposition', `attachment; filename="plotwell-data-export-${new Date().toISOString().split('T')[0]}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);

  } catch (error: any) {
    console.error('❌ DATA EXPORT ERROR:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

/**
 * Invalidate all other sessions after password change (M10)
 * Frontend calls this after successful supabase.auth.updateUser({ password })
 */
router.post('/invalidate-sessions', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found' });
    }

    // Sign out all sessions for this user except the current one
    const { error } = await supabase.auth.admin.signOut(userId, 'others');

    if (error) {
      console.error('❌ Session invalidation error:', error);
      return res.status(500).json({ error: 'Failed to invalidate sessions' });
    }

    console.log(`✅ Sessions invalidated for user ${userId.slice(0, 8)}***`);
    res.json({ success: true, message: 'All other sessions have been invalidated' });

  } catch (error: any) {
    console.error('❌ SESSION INVALIDATION ERROR:', error);
    res.status(500).json({ error: 'Failed to invalidate sessions' });
  }
});

export default router;