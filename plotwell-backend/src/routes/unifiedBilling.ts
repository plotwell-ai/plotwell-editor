import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth';
import { unifiedBillingService, BillingChangeRequest, BillingPreview } from '../services/unifiedBillingService';
import { stripeService } from '../services/stripeService';
import { createClient } from '@supabase/supabase-js';
import { getPlanIdFromStripePrice } from '../config/pricingPlans';
import { detectCurrencyFromRequest } from '../config/currencies';
import { acquireLockWithResult, getLockResult } from '../services/operationLockService';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const router = express.Router();

// Helper function to get user ID from request
function getUserId(req: any): string | null {
  return req.user?.sub || req.user?.id || null;
}

const IDEMPOTENCY_WINDOW_SECONDS = 60; // 1 minute

// Generate idempotency key for billing operations
function generateIdempotencyKey(userId: string, request: BillingChangeRequest): string {
  const keyData = {
    userId,
    type: request.type,
    target_plan: request.target_plan,
    billing_cycle: request.billing_cycle,
    addons: request.addons
  };
  return `billing_${userId}_${JSON.stringify(keyData).replace(/\s/g, '')}`;
}

// Rate limiting for billing operations
const billingPreviewLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 preview requests per minute
  message: {
    error: 'Too many billing preview requests. Please try again later.',
    retry_after: 60
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const billingChangeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 billing change requests per minute
  message: {
    error: 'Too many billing change requests. Please try again later.',
    retry_after: 60
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Input validation for BillingChangeRequest
function validateBillingChangeRequest(body: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate type - NEW SIMPLIFIED MODEL
  const validTypes = ['new', 'cancel', 'addon_change'];
  if (!body.type || !validTypes.includes(body.type)) {
    errors.push(`type is required and must be one of: ${validTypes.join(', ')}`);
  }

  // Validate target_plan for relevant types
  if (['new'].includes(body.type)) {
    const validPlans = ['paid']; // NEW MODEL: Only 'paid' plan available
    if (!body.target_plan || !validPlans.includes(body.target_plan)) {
      errors.push(`target_plan is required for ${body.type} and must be one of: ${validPlans.join(', ')}`);
    }
  }

  // Validate billing_cycle for new subscriptions
  if (body.type === 'new' && body.billing_cycle) {
    const validCycles = ['monthly', 'yearly'];
    if (!validCycles.includes(body.billing_cycle)) {
      errors.push(`billing_cycle must be one of: ${validCycles.join(', ')}`);
    }
  }

  // Validate addons if present
  if (body.addons) {
    if (typeof body.addons !== 'object') {
      errors.push('addons must be an object');
    } else {
      if (body.addons.additional_projects !== undefined) {
        const projects = body.addons.additional_projects;
        if (!Number.isInteger(projects) || projects < 0 || projects > 100) {
          errors.push('additional_projects must be an integer between 0 and 100');
        }
      }

      if (body.addons.additional_collaborators !== undefined) {
        const collaborators = body.addons.additional_collaborators;
        if (!Number.isInteger(collaborators) || collaborators < 0 || collaborators > 100) {
          errors.push('additional_collaborators must be an integer between 0 and 100');
        }
      }

      if (body.addons.additional_image_credit_packs !== undefined) {
        const packs = body.addons.additional_image_credit_packs;
        if (!Number.isInteger(packs) || packs < 0 || packs > 100) {
          errors.push('additional_image_credit_packs must be an integer between 0 and 100');
        }
      }
    }
  }

  // Validate immediate_cancellation for cancel type
  if (body.type === 'cancel' && body.immediate_cancellation !== undefined) {
    if (typeof body.immediate_cancellation !== 'boolean') {
      errors.push('immediate_cancellation must be a boolean');
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * POST /api/billing/preview - Preview any billing change
 * Returns cost breakdown and billing preview without executing the change
 */
router.post('/preview', requireAuth, billingPreviewLimiter, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        error: 'User not authenticated properly',
        code: 'AUTH_REQUIRED'
      });
    }

    // Validate request body
    const validation = validateBillingChangeRequest(req.body);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Invalid request data',
        code: 'VALIDATION_ERROR',
        details: validation.errors
      });
    }

    const currency = detectCurrencyFromRequest(req);
    const request: BillingChangeRequest = {
      type: req.body.type,
      target_plan: req.body.target_plan,
      billing_cycle: req.body.billing_cycle || 'monthly',
      addons: req.body.addons,
      currency: currency.toLowerCase()
    };

    // Get billing preview from service
    const preview: BillingPreview = await unifiedBillingService.previewBillingChange(userId, request);

    res.json(preview);

  } catch (error: any) {
    console.error('❌ BILLING PREVIEW ERROR:', error);

    // Handle specific error types
    let statusCode = 500;
    let errorCode = 'INTERNAL_ERROR';
    let message = 'Failed to generate billing preview';

    if (error.message) {
      if (error.message.includes('not found')) {
        statusCode = 404;
        errorCode = 'RESOURCE_NOT_FOUND';
        message = error.message;
      } else if (error.message.includes('invalid') || error.message.includes('required')) {
        statusCode = 400;
        errorCode = 'INVALID_REQUEST';
        message = error.message;
      } else if (error.message.includes('No active subscription')) {
        statusCode = 400;
        errorCode = 'NO_SUBSCRIPTION';
        message = 'No active subscription found for this operation';
      }
    }

    res.status(statusCode).json({
      error: message,
      code: errorCode,
      // Error details logged server-side only (S6 security fix)
    });
  }
});

/**
 * POST /api/billing/change - Execute any billing change
 * Processes the actual billing change (plan changes, addons, cancellations)
 */
router.post('/change', requireAuth, billingChangeLimiter, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        error: 'User not authenticated properly',
        code: 'AUTH_REQUIRED'
      });
    }

    // Validate request body
    const validation = validateBillingChangeRequest(req.body);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Invalid request data',
        code: 'VALIDATION_ERROR',
        details: validation.errors
      });
    }

    const currency = detectCurrencyFromRequest(req);
    const request: BillingChangeRequest = {
      type: req.body.type,
      target_plan: req.body.target_plan,
      billing_cycle: req.body.billing_cycle || 'monthly',
      addons: req.body.addons,
      currency: currency.toLowerCase()
    };

    // Check for duplicate operation (idempotency protection)
    // IMPORTANT: Do NOT cache checkout sessions ('new' type) because Stripe sessions
    // can only be used once and cannot be reinitialized
    // Only apply idempotency for operations that modify existing subscriptions
    const shouldCheckIdempotency = ['upgrade', 'addon_change'].includes(request.type);

    if (shouldCheckIdempotency) {
      const idempotencyKey = generateIdempotencyKey(userId, request);
      const cachedResult = await getLockResult('billing_idempotency', idempotencyKey);

      if (cachedResult) {
        return res.json({
          ...cachedResult,
          is_duplicate_request: true,
        });
      }
    }

    // Execute billing change
    const result = await unifiedBillingService.executeBillingChange(userId, request);

    if (!result.success) {
      return res.status(400).json({
        error: result.message,
        code: 'BILLING_OPERATION_FAILED',
        details: result.details
      });
    }

    // Transform response to include additional fields
    const response = {
      success: true,
      operation_type: request.type,
      message: result.message,
      details: result.details,
      // Include checkout URL if this is a new subscription requiring payment
      checkout_url: result.details?.checkout_url,
      session_id: result.details?.session_id,
      // Include subscription details for successful operations
      subscription_id: result.details?.subscription_id,
      timestamp: new Date().toISOString()
    };

    // Cache successful operation for idempotency protection (only if we checked idempotency)
    if (shouldCheckIdempotency) {
      const idempotencyKey = generateIdempotencyKey(userId, request);
      await acquireLockWithResult('billing_idempotency', idempotencyKey, IDEMPOTENCY_WINDOW_SECONDS, response);
    }

    res.json(response);

  } catch (error: any) {
    console.error('❌ BILLING CHANGE ERROR:', error);

    // Handle specific error types with more granular responses
    let statusCode = 500;
    let errorCode = 'INTERNAL_ERROR';
    let message = 'Failed to execute billing change';

    if (error.message) {
      // Stripe payment errors
      if (error.type && error.type.includes('Stripe')) {
        statusCode = 402;
        errorCode = 'PAYMENT_ERROR';
        if (error.code === 'insufficient_funds') {
          message = 'Insufficient funds on payment method';
          errorCode = 'INSUFFICIENT_FUNDS';
        } else if (error.code === 'card_declined') {
          message = 'Payment method declined';
          errorCode = 'CARD_DECLINED';
        } else {
          message = 'Payment processing failed';
        }
      }
      // Business logic errors
      else if (error.message.includes('not found')) {
        statusCode = 404;
        errorCode = 'RESOURCE_NOT_FOUND';
        message = error.message;
      } else if (error.message.includes('invalid') || error.message.includes('required')) {
        statusCode = 400;
        errorCode = 'INVALID_REQUEST';
        message = error.message;
      } else if (error.message.includes('No active subscription')) {
        statusCode = 400;
        errorCode = 'NO_SUBSCRIPTION';
        message = 'No active subscription found for this operation';
      } else if (error.message.includes('usage') || error.message.includes('limit')) {
        statusCode = 400;
        errorCode = 'USAGE_LIMIT_EXCEEDED';
        message = error.message;
      }
      // Database errors
      else if (error.message.includes('database') || error.message.includes('connection')) {
        statusCode = 503;
        errorCode = 'SERVICE_UNAVAILABLE';
        message = 'Billing service temporarily unavailable';
      }
    }

    res.status(statusCode).json({
      error: message,
      code: errorCode,
      details: process.env.NODE_ENV === 'development' ? {
        original_error: error.message,
        stack: error.stack
      } : undefined
    });
  }
});

/**
 * POST /api/billing/clear-checkout - Clear checkout state and cooldown
 * Call this when user cancels checkout or goes back to allow immediate retry
 */
router.post('/clear-checkout', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        error: 'User not authenticated properly',
        code: 'AUTH_REQUIRED'
      });
    }

    // Clear the billing cooldown for this user
    await unifiedBillingService.clearCooldown(userId);

    // Also try to expire any open checkout sessions for this user
    try {
      const { data: user } = await supabase
        .from('users')
        .select('stripe_customer_id')
        .eq('id', userId)
        .single();

      if (user?.stripe_customer_id) {
        await stripeService.expireIncompleteCheckoutSessions(user.stripe_customer_id);
      }
    } catch (stripeError) {
      // Non-critical - log but don't fail
      console.warn('⚠️ Could not expire checkout sessions:', stripeError);
    }

    res.json({
      success: true,
      message: 'Checkout state cleared. You can retry now.'
    });

  } catch (error: any) {
    console.error('❌ CLEAR CHECKOUT ERROR:', error);
    res.status(500).json({
      error: 'Failed to clear checkout state',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /api/billing/subscription-status - Get current subscription status
 * Returns current user's subscription information
 */
router.get('/subscription-status', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        error: 'User not authenticated properly',
        code: 'AUTH_REQUIRED'
      });
    }

    const currentState = await unifiedBillingService.getCurrentSubscription(userId);

    res.json({
      success: true,
      subscription: currentState,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('❌ SUBSCRIPTION STATUS ERROR:', error);
    res.status(500).json({
      error: 'Failed to get subscription status',
      code: 'INTERNAL_ERROR',
      // Error details logged server-side only (S6 security fix)
    });
  }
});

/**
 * POST /api/billing/create-checkout-session - Create Stripe checkout session (proper customer reuse)
 */
router.post('/create-checkout-session', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { plan_id, billing_cycle = 'monthly' } = req.body;

    // Detect currency from request headers or query param
    const currency = detectCurrencyFromRequest(req);

    // Get plan pricing
    const { getStripePriceId } = require('../config/pricingPlans');
    const priceId = getStripePriceId(plan_id, billing_cycle);

    if (!priceId) {
      return res.status(400).json({ error: 'Invalid plan or billing cycle' });
    }

    // Use stripeService.createCheckoutSession to properly handle customer reuse
    // IMPORTANT: Use embedded: true to match the main billing flow
    const session = await stripeService.createCheckoutSession(userId, priceId, {
      plan_id: plan_id,
      billing_cycle: billing_cycle
    }, true, currency.toLowerCase()); // Enable embedded mode + multi-currency

    res.json({
      success: true,
      checkout_url: session.url,
      session_id: session.id,
      client_secret: session.client_secret // For embedded checkout
    });

  } catch (error: any) {
    console.error('❌ CHECKOUT SESSION ERROR:', error);
    res.status(500).json({
      error: 'Failed to create checkout session'
    });
  }
});

/**
 * POST /api/billing/update-payment-method - Create embedded checkout session for updating payment method
 */
router.post('/update-payment-method', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Get customer ID from users table
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (userError || !user || !user.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    // Initialize Stripe
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-08-27.basil',
    });

    // Create embedded checkout session in setup mode
    const session = await stripe.checkout.sessions.create({
      customer: user.stripe_customer_id,
      mode: 'setup',
      ui_mode: 'embedded',
      return_url: `${process.env.FRONTEND_URL?.split(',')[0] || 'http://localhost:5173'}/profile?tab=billing&payment_updated=true`,
      payment_method_types: ['card'],
      metadata: {
        user_id: userId,
        action_type: 'payment_method_update'
      }
    });

    res.json({
      success: true,
      client_secret: session.client_secret,
      session_id: session.id
    });

  } catch (error: any) {
    console.error('❌ CREATE PAYMENT METHOD UPDATE SESSION ERROR:', error);
    res.status(500).json({
      error: 'Failed to create payment method update session',
      // Error details logged server-side only (S6 security fix)
    });
  }
});

/**
 * POST /api/billing/cancel-subscription - Cancel subscription
 */
router.post('/cancel-subscription', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const { immediate = false } = req.body;

    const result = await unifiedBillingService.executeBillingChange(userId, {
      type: 'cancel',
      immediate_cancellation: immediate
    });

    res.json(result);
  } catch (error: any) {
    console.error('❌ CANCEL SUBSCRIPTION ERROR:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

/**
 * POST /api/billing/downgrade-subscription - Cancel subscription (paid → free)
 * NOTE: In new model, this is just cancellation since there's only one paid tier
 */
router.post('/downgrade-subscription', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // NEW MODEL: Downgrade = Cancellation (paid → free)
    const result = await unifiedBillingService.executeBillingChange(userId, {
      type: 'cancel'
    });

    res.json(result);
  } catch (error: any) {
    console.error('❌ CANCEL SUBSCRIPTION ERROR:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

/**
 * POST /api/billing/reactivate-subscription - Reactivate a cancelled subscription
 */
router.post('/reactivate-subscription', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Get current subscription
    const { data: user } = await supabase
      .from('users')
      .select('stripe_subscription_id')
      .eq('id', userId)
      .single();

    if (!user?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No subscription found to reactivate' });
    }

    // Update Stripe subscription to remove cancel_at_period_end flag
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const subscription = await stripe.subscriptions.update(user.stripe_subscription_id, {
      cancel_at_period_end: false
    });

    // Sync addon quantities from Stripe subscription items
    const { getAddonTypeFromPriceId } = require('../config/pricingPlans');
    let additionalProjects = 0;
    let additionalCollaborators = 0;

    if (subscription.items?.data) {
      for (const item of subscription.items.data) {
        const priceId = item.price?.id;
        if (!priceId) continue;
        const addonType = getAddonTypeFromPriceId(priceId);
        if (addonType === 'additional_projects') {
          additionalProjects = item.quantity || 0;
        } else if (addonType === 'additional_collaborators') {
          additionalCollaborators = item.quantity || 0;
        }
      }
    }

    // Update local database — restore plan status AND addon quantities from Stripe
    await supabase
      .from('user_subscriptions')
      .update({
        plan_id: 'paid',
        status: 'active',
        cancel_at_period_end: false,
        stripe_subscription_id: subscription.id,
        additional_projects: additionalProjects,
        additional_collaborators: additionalCollaborators,
        current_period_end: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    console.log(`✅ Subscription reactivated for user ${userId.slice(0, 8)}*** (projects: +${additionalProjects}, collabs: +${additionalCollaborators})`);

    res.json({
      success: true,
      message: 'Subscription reactivated successfully',
      subscription_id: subscription.id,
      current_period_end: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null
    });

  } catch (error: any) {
    console.error('❌ REACTIVATE SUBSCRIPTION ERROR:', error);
    res.status(500).json({ error: 'Failed to reactivate subscription' });
  }
});


/**
 * POST /api/billing/verify-payment - Verify embedded checkout payment completion
 */
router.post('/verify-payment', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        error: 'User not authenticated properly',
        code: 'AUTH_REQUIRED'
      });
    }

    const { session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({
        error: 'Session ID is required',
        code: 'MISSING_SESSION_ID'
      });
    }

    // Import Stripe here to avoid circular dependencies
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-08-27.basil',
    });

    // Idempotency: check if this session was already verified
    const { data: existingEvent } = await supabase
      .from('billing_events')
      .select('id')
      .eq('user_id', userId)
      .eq('event_type', 'payment_verified')
      .contains('event_data', { session_id })
      .limit(1);

    if (existingEvent && existingEvent.length > 0) {
      console.log(`⚠️ Session ${session_id} already verified for user ${userId.slice(0, 8)}***, returning success`);
      return res.json({
        success: true,
        message: 'Payment already verified',
        already_processed: true
      });
    }

    // Retrieve the checkout session from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription']
    });

    // Check if payment was successful
    if (session.payment_status !== 'paid') {
      return res.status(400).json({
        error: 'Payment not completed',
        code: 'PAYMENT_NOT_COMPLETED',
        payment_status: session.payment_status
      });
    }

    // Check if this session belongs to this user
    if (session.metadata?.user_id !== userId) {
      return res.status(403).json({
        error: 'Session does not belong to this user',
        code: 'UNAUTHORIZED_SESSION'
      });
    }

    // If subscription was created, update local state
    if (session.subscription) {
      let subscription;
      if (typeof session.subscription === 'string') {
        subscription = await stripe.subscriptions.retrieve(session.subscription);
      } else {
        subscription = session.subscription;
      }

      const priceId = subscription.items.data[0]?.price?.id;

      // Map Stripe price ID to plan ID using env-configured prices
      const planId = getPlanIdFromStripePrice(priceId) || 'free';

      // Update users table
      await supabase
        .from('users')
        .update({
          current_plan: planId,
          subscription_status: subscription.status,
          stripe_customer_id: session.customer,
          stripe_subscription_id: subscription.id,
          current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : null,
          current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
          cancel_at_period_end: subscription.cancel_at_period_end || false,
          updated_at: new Date().toISOString()
        })
        .eq('id', userId);

      // Extract proper period dates from subscription
      const periodStart = subscription.current_period_start || subscription.start_date || subscription.created;
      const periodEnd = subscription.current_period_end || (periodStart ? periodStart + (30 * 24 * 60 * 60) : null); // Fallback: 30 days later

      // Update user_subscriptions table
      const subscriptionData = {
        user_id: userId,
        plan_id: planId,
        status: subscription.status,
        stripe_subscription_id: subscription.id,
        current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        cancel_at_period_end: subscription.cancel_at_period_end || false,
        additional_projects: 0,
        additional_collaborators: 0,
        updated_at: new Date().toISOString()
      };

      const { error: subscriptionError } = await supabase
        .from('user_subscriptions')
        .upsert(subscriptionData, {
          onConflict: 'user_id',
          ignoreDuplicates: false
        });

      if (subscriptionError) {
        console.error('❌ Error updating user_subscriptions:', subscriptionError);
        throw new Error(`Failed to update subscription: ${subscriptionError.message}`);
      }

      // 🎁 LAUNCH OFFER: Grant 200 free AI credits to new paid subscribers (one-time only)
      if (planId === 'paid') {
        try {
          // Check if user already received launch offer (prevents duplicates)
          const { data: existingGrant } = await supabase
            .from('ai_credit_transactions')
            .select('id')
            .eq('user_id', userId)
            .eq('transaction_type', 'grant')
            .ilike('description', '%launch offer%')
            .limit(1);

          if (!existingGrant || existingGrant.length === 0) {
            const { PricingService } = require('../services/pricingService');
            const pricingService = new PricingService(supabase);
            await pricingService.addAICredits(
              userId,
              200,
              '🎁 Launch offer: 200 free AI credits with subscription',
              { promotion: 'launch_offer', stripe_checkout_session_id: session_id }
            );
            if (DEBUG_AI) console.log(`🎁 Granted 200 launch offer credits to user ${userId.slice(0, 8)}***`);
          }
        } catch (creditError) {
          console.error('⚠️ Failed to grant launch offer credits:', creditError);
          // Don't fail the whole verification for bonus credits
        }
      }
    }

    // Record billing event for idempotency and audit trail
    await supabase
      .from('billing_events')
      .insert({
        user_id: userId,
        event_type: 'payment_verified',
        event_data: {
          session_id,
          payment_status: session.payment_status,
          subscription_id: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
          mode: session.mode
        }
      });

    res.json({
      success: true,
      message: 'Payment verified successfully',
      session_status: session.status,
      payment_status: session.payment_status,
      subscription_id: session.subscription
    });

  } catch (error: any) {
    console.error('❌ PAYMENT VERIFICATION ERROR:', error);

    let statusCode = 500;
    let errorCode = 'INTERNAL_ERROR';
    let message = 'Failed to verify payment';

    if (error.type === 'StripeInvalidRequestError') {
      statusCode = 400;
      errorCode = 'INVALID_SESSION';
      message = 'Invalid checkout session ID';
    }

    res.status(statusCode).json({
      error: message,
      code: errorCode,
      // Error details logged server-side only (S6 security fix)
    });
  }
});

/**
 * Get available pricing plans
 */
router.get('/plans', (req, res) => {
  try {
    const { PRICING_PLANS } = require('../config/pricingPlans');

    // Convert pricing plans to array format
    const plansArray = Object.values(PRICING_PLANS).filter((plan: any) => plan.status === 'active');

    res.json({
      success: true,
      plans: plansArray
    });
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({
      error: 'Failed to fetch plans'
    });
  }
});

/**
 * GET /api/billing/upcoming-invoice - Get upcoming invoice details
 * Returns next billing date, amount, and line items for active subscriptions
 */
router.get('/upcoming-invoice', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        error: 'User not authenticated properly',
        code: 'AUTH_REQUIRED'
      });
    }

    if (DEBUG_AI) console.log('🔍 FETCHING UPCOMING INVOICE FOR USER:', userId);

    // Get user's Stripe customer ID and subscription ID
    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('id', userId)
      .single();

    if (!user?.stripe_customer_id) {
      return res.status(404).json({
        error: 'No active subscription found',
        code: 'NO_SUBSCRIPTION'
      });
    }

    // Also get the subscription ID from user_subscriptions table
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    const subscriptionId = subscription?.stripe_subscription_id || user.stripe_subscription_id;

    // Fetch upcoming invoice from Stripe
    const upcomingInvoice = await stripeService.getUpcomingInvoice(user.stripe_customer_id, subscriptionId);

    if (!upcomingInvoice) {
      return res.status(404).json({
        error: 'No upcoming invoice found',
        code: 'NO_UPCOMING_INVOICE'
      });
    }

    // Format response
    const response = {
      success: true,
      invoice: {
        amount_due: upcomingInvoice.amount_due, // in cents
        currency: upcomingInvoice.currency,
        period_start: upcomingInvoice.period_start
          ? new Date(upcomingInvoice.period_start * 1000).toISOString()
          : null,
        period_end: upcomingInvoice.period_end
          ? new Date(upcomingInvoice.period_end * 1000).toISOString()
          : null,
        next_payment_attempt: upcomingInvoice.next_payment_attempt
          ? new Date(upcomingInvoice.next_payment_attempt * 1000).toISOString()
          : null,
        line_items: upcomingInvoice.lines.data.map((line: any) => ({
          description: line.description,
          amount: line.amount,
          quantity: line.quantity,
          period_start: line.period?.start
            ? new Date(line.period.start * 1000).toISOString()
            : null,
          period_end: line.period?.end
            ? new Date(line.period.end * 1000).toISOString()
            : null
        }))
      }
    };

    res.json(response);
  } catch (error: any) {
    console.error('❌ UPCOMING INVOICE ERROR:', error);

    let statusCode = 500;
    let errorCode = 'INTERNAL_ERROR';
    let message = 'Failed to fetch upcoming invoice';

    if (error.code === 'invoice_upcoming_none') {
      statusCode = 404;
      errorCode = 'NO_UPCOMING_INVOICE';
      message = 'No upcoming invoice found for this subscription';
    }

    res.status(statusCode).json({
      error: message,
      code: errorCode,
      // Error details logged server-side only (S6 security fix)
    });
  }
});

/**
 * GET /api/billing/payment-method
 * Get saved payment method details for the current user
 */
router.get('/payment-method', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get Stripe customer ID from users table
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get subscription status from user_subscriptions table
    const { data: subscription, error: subError } = await supabase
      .from('user_subscriptions')
      .select('plan_id, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    // Only fetch payment method for paid plan users with Stripe customer
    if (!subscription || subscription.plan_id === 'free' || !user.stripe_customer_id) {
      return res.status(200).json({ payment_method: null });
    }

    // Get payment method from Stripe
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-08-27.basil',
    });

    // Get customer to find default payment method
    const customer = await stripe.customers.retrieve(user.stripe_customer_id);

    if (customer.deleted) {
      return res.status(200).json({ payment_methods: [] });
    }

    // Get default payment method ID
    const defaultPMId = customer.invoice_settings?.default_payment_method;
    const defaultPaymentMethodId = typeof defaultPMId === 'string' ? defaultPMId : defaultPMId?.id;

    // List all payment methods for this customer
    const paymentMethods = await stripe.paymentMethods.list({
      customer: user.stripe_customer_id,
      limit: 10
    });

    // Map payment methods to frontend format
    const paymentMethodsData = paymentMethods.data.map((pm: any) => ({
      id: pm.id,
      type: pm.type,
      is_default: pm.id === defaultPaymentMethodId,
      card: pm.card ? {
        brand: pm.card.brand,
        last4: pm.card.last4,
        exp_month: pm.card.exp_month,
        exp_year: pm.card.exp_year
      } : null,
      link: pm.link ? {
        email: pm.link.email
      } : null,
      billing_details: {
        email: pm.billing_details?.email,
        name: pm.billing_details?.name
      },
      created: pm.created
    }));

    // Sort: default first, then by creation date (newest first)
    paymentMethodsData.sort((a: any, b: any) => {
      if (a.is_default && !b.is_default) return -1;
      if (!a.is_default && b.is_default) return 1;
      return b.created - a.created;
    });

    res.json({ payment_methods: paymentMethodsData });

  } catch (error: any) {
    console.error('Error fetching payment method:', error);
    res.status(500).json({
      error: 'Failed to fetch payment method',
      // Error details logged server-side only (S6 security fix)
    });
  }
});

/**
 * DELETE /api/billing/delete-payment-method/:paymentMethodId
 * Delete a payment method (cannot delete the default one)
 */
router.delete('/delete-payment-method/:paymentMethodId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { paymentMethodId } = req.params;

    // Get user's stripe_customer_id
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (userError || !user || !user.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    // Initialize Stripe
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-08-27.basil',
    });

    // Get customer to check if this is the default payment method
    const customer = await stripe.customers.retrieve(user.stripe_customer_id);
    const defaultPMId = customer.invoice_settings?.default_payment_method;
    const defaultPaymentMethodId = typeof defaultPMId === 'string' ? defaultPMId : defaultPMId?.id;

    if (paymentMethodId === defaultPaymentMethodId) {
      return res.status(400).json({
        error: 'Cannot delete default payment method',
        message: 'Please set another payment method as default before deleting this one'
      });
    }

    // Detach the payment method from the customer
    await stripe.paymentMethods.detach(paymentMethodId);

    res.json({
      success: true,
      message: 'Payment method deleted successfully'
    });

  } catch (error: any) {
    console.error('❌ Error deleting payment method:', error);
    res.status(500).json({
      error: 'Failed to delete payment method',
      // Error details logged server-side only (S6 security fix)
    });
  }
});

/**
 * POST /api/billing/fulfill
 * Verify payment and create subscription record (called after checkout redirect)
 * This eliminates the need for webhooks - frontend calls this after Stripe redirect
 */
router.post('/fulfill', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    // Initialize Stripe
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-08-27.basil',
    });

    // Retrieve the checkout session from Stripe with expanded subscription
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription']
    });

    // Verify this session belongs to this user
    if (session.metadata?.user_id !== userId) {
      return res.status(403).json({ error: 'Session does not belong to this user' });
    }

    // Verify payment was successful
    if (session.payment_status !== 'paid') {
      return res.status(400).json({
        error: 'Payment not completed',
        payment_status: session.payment_status
      });
    }

    // Check if this is a subscription session
    if (session.mode !== 'subscription' || !session.subscription) {
      return res.status(400).json({ error: 'Invalid session type - not a subscription' });
    }

    // Get the subscription
    let subscription;
    if (typeof session.subscription === 'string') {
      subscription = await stripe.subscriptions.retrieve(session.subscription);
    } else {
      subscription = session.subscription;
    }

    // Check idempotency - see if subscription already exists in our DB
    const { data: existingSubscription } = await supabase
      .from('user_subscriptions')
      .select('id, stripe_subscription_id, status')
      .eq('user_id', userId)
      .eq('stripe_subscription_id', subscription.id)
      .single();

    if (existingSubscription && existingSubscription.status === 'active') {
      // Already fulfilled, return success
      return res.json({
        success: true,
        already_fulfilled: true,
        message: 'Subscription already active',
        plan_id: 'paid'
      });
    }

    // Map price ID to plan ID
    const priceId = subscription.items.data[0]?.price?.id;
    const planId = 'paid'; // New simplified model - only one paid tier

    // Extract billing details for analytics
    const priceItem = subscription.items.data[0]?.price;
    const billingCycle = priceItem?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
    const amountPaid = session.amount_total ? session.amount_total / 100 : 0; // Convert cents to EUR
    const currency = session.currency?.toUpperCase() || 'EUR';

    // Extract period dates
    const periodStart = subscription.current_period_start;
    const periodEnd = subscription.current_period_end;

    // Extract customer ID (can be string or object with id)
    const customerId = typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id;

    // Update users table
    const { error: userUpdateError } = await supabase
      .from('users')
      .update({
        current_plan: planId,
        subscription_status: subscription.status,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
        current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        cancel_at_period_end: subscription.cancel_at_period_end || false,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (userUpdateError) {
      console.error('❌ Error updating users table:', userUpdateError);
      throw new Error(`Failed to update user record: ${userUpdateError.message}`);
    }

    // Upsert user_subscriptions table
    const subscriptionData = {
      user_id: userId,
      plan_id: planId,
      status: subscription.status,
      stripe_subscription_id: subscription.id,
      current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      cancel_at_period_end: subscription.cancel_at_period_end || false,
      additional_projects: 0,
      additional_collaborators: 0,
      updated_at: new Date().toISOString()
    };

    const { error: subscriptionError } = await supabase
      .from('user_subscriptions')
      .upsert(subscriptionData, {
        onConflict: 'user_id',
        ignoreDuplicates: false
      });

    if (subscriptionError) {
      console.error('❌ Error upserting subscription:', subscriptionError);
      throw new Error(`Failed to save subscription: ${subscriptionError.message}`);
    }

    // Initialize user_quotas if needed
    await supabase
      .from('user_quotas')
      .upsert({
        user_id: userId,
        ai_generations_used: 0,
        ai_credits_balance: 0,
        storage_used_gb: 0,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id',
        ignoreDuplicates: true // Don't overwrite if exists
      });

    // 🎁 LAUNCH OFFER: Grant 200 free AI credits to new paid subscribers (one-time only)
    let creditsGranted = false;
    if (planId === 'paid') {
      try {
        // Check if user already received launch offer (prevents duplicates)
        const { data: existingGrant } = await supabase
          .from('ai_credit_transactions')
          .select('id')
          .eq('user_id', userId)
          .eq('transaction_type', 'grant')
          .ilike('description', '%launch offer%')
          .limit(1);

        if (!existingGrant || existingGrant.length === 0) {
          const { PricingService } = require('../services/pricingService');
          const pricingService = new PricingService(supabase);
          await pricingService.addAICredits(
            userId,
            200,
            '🎁 Launch offer: 200 free AI credits with subscription',
            { promotion: 'launch_offer', stripe_checkout_session_id: session_id }
          );
          creditsGranted = true;
          if (DEBUG_AI) console.log(`🎁 Granted 200 launch offer credits to user ${userId.slice(0, 8)}***`);
        }
      } catch (creditError) {
        console.error('⚠️ Failed to grant launch offer credits:', creditError);
        // Don't fail the whole fulfillment for bonus credits
      }
    }

    if (DEBUG_AI) console.log(`✅ Subscription fulfilled for user ${userId.slice(0, 8)}*** - plan: ${planId}`);

    res.json({
      success: true,
      plan_id: planId,
      subscription_id: subscription.id,
      status: subscription.status,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      credits_granted: creditsGranted ? 200 : 0,
      // Analytics data
      billing_cycle: billingCycle,
      amount_paid: amountPaid,
      currency: currency
    });

  } catch (error: any) {
    console.error('❌ SUBSCRIPTION FULFILL ERROR:', error);
    res.status(500).json({
      error: 'Failed to fulfill subscription',
      // Error details logged server-side only (S6 security fix)
    });
  }
});

/**
 * GET /api/billing/invoices - Get user's invoice history
 * Returns past invoices from Stripe, or empty array for free users
 */
router.get('/invoices', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        error: 'User not authenticated properly',
        code: 'AUTH_REQUIRED'
      });
    }

    // Get user's Stripe customer ID and profile info
    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id, full_name, email')
      .eq('id', userId)
      .single();

    // No Stripe customer = no invoices (free user)
    if (!user?.stripe_customer_id) {
      return res.json({ invoices: [] });
    }

    // Initialize Stripe
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-08-27.basil',
    });

    // Fetch paid invoices (have line items with product descriptions)
    const invoices = await stripe.invoices.list({
      customer: user.stripe_customer_id,
      limit: 50
    });

    // Get customer's default payment method for display
    const customer = await stripe.customers.retrieve(user.stripe_customer_id);
    let defaultPaymentMethod = 'Card';
    if ((customer as any).invoice_settings?.default_payment_method) {
      try {
        const pm = await stripe.paymentMethods.retrieve(
          (customer as any).invoice_settings.default_payment_method
        );
        if (pm.card) {
          defaultPaymentMethod = `${pm.card.brand?.charAt(0).toUpperCase()}${pm.card.brand?.slice(1)} •••• ${pm.card.last4}`;
        }
      } catch (e) {
        // Fallback to 'Card'
      }
    }

    // Map invoices to frontend format
    const invoiceData = invoices.data
      .filter((inv: any) => inv.status === 'paid')
      .map((inv: any) => {
        // Build description from line items (e.g. "Pro Plan Monthly", "AI Credits Pack - 200 credits")
        const lineDescriptions = inv.lines?.data
          ?.map((line: any) => line.description)
          .filter(Boolean)
          .join(', ') || 'plotwell';

        return {
          id: inv.id,
          number: inv.number,
          amount_paid: inv.amount_paid,
          currency: inv.currency,
          status: inv.status,
          created: inv.created,
          description: lineDescriptions,
          payment_method: defaultPaymentMethod,
          customer_name: user?.full_name || user?.email || ''
        };
      });

    res.json({ invoices: invoiceData });

  } catch (error: any) {
    console.error('❌ INVOICES FETCH ERROR:', error.message || 'Unknown error');
    res.status(500).json({
      error: 'Failed to fetch invoices',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;