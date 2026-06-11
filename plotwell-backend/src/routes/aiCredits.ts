import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth';
import { extractUserId, addPricingService, PricingRequest } from '../middleware/pricingMiddleware';
import { PricingService } from '../services/pricingService';
import { AI_CREDITS_CONFIG, getAICreditsPriceId, getEffectiveCost } from '../config/pricingPlans';
import { detectCurrencyFromRequest, getPricesForCurrency, CurrencyCode } from '../config/currencies';

const router = express.Router();

// Initialize Stripe — fail fast if key is missing
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is not set. AI credits payment routes will not work.');
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_missing', {
  apiVersion: '2025-08-27.basil'
});

// Initialize Supabase client lazily
let supabase: any = null;
const getSupabaseClient = () => {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Missing Supabase environment variables');
    }
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
};

const getPublicAICreditPacks = () =>
  Object.values(AI_CREDITS_CONFIG.packs).map(pack => ({
    id: pack.id,
    credits: pack.credits,
    price_dollars: pack.priceDollars,
    currency: pack.currency
  }));

/**
 * GET /api/ai-credits/balance
 * Get current AI credits balance
 */
router.get('/balance', requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const pricingService = req.pricingService || new PricingService(getSupabaseClient());
    const balance = await pricingService.getAICreditsBalance(userId);

    // Get subscription to check if user can purchase
    const { isPaidSubscription } = require('../utils/subscriptionHelpers');
    const subscription = await pricingService.getUserSubscription(userId);
    const canPurchase = isPaidSubscription(subscription);

    res.json({
      balance,
      can_purchase: canPurchase,
      costs: AI_CREDITS_CONFIG.costs,
      effective_costs: {
        image: getEffectiveCost('image'),
        video: getEffectiveCost('video'),
        creative: getEffectiveCost('creative')
      },
      launch_discount: AI_CREDITS_CONFIG.launchDiscount,
      pack: {
        credits: AI_CREDITS_CONFIG.pack.credits,
        price_dollars: AI_CREDITS_CONFIG.pack.priceDollars,
        currency: AI_CREDITS_CONFIG.pack.currency
      },
      packs: getPublicAICreditPacks()
    });
  } catch (error) {
    console.error('Error getting AI credits balance:', error);
    res.status(500).json({ error: 'Failed to get AI credits balance' });
  }
});

/**
 * POST /api/ai-credits/purchase
 * Create a Stripe checkout session for purchasing AI credits (one-time payment)
 */
router.post('/purchase', requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get pack type from request body (default to 'small' for backwards compatibility)
    const packType = req.body?.pack || 'small';
    const selectedPack = AI_CREDITS_CONFIG.packs[packType as keyof typeof AI_CREDITS_CONFIG.packs];

    if (!selectedPack) {
      return res.status(400).json({ error: 'Invalid pack type. Use "small", "large", or "bulk".' });
    }

    const pricingService = req.pricingService || new PricingService(getSupabaseClient());

    // Get or create Stripe customer
    const supabaseClient = getSupabaseClient();
    const { data: user, error: userError } = await supabaseClient
      .from('users')
      .select('id, email, stripe_customer_id, ui_language')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let customerId = user.stripe_customer_id;

    // Create Stripe customer if not exists
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          supabase_user_id: userId
        }
      });
      customerId = customer.id;

      // Save customer ID
      await supabaseClient
        .from('users')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
    }

    // Detect currency from request (query param or geo header)
    const currency = detectCurrencyFromRequest(req);
    const currencyPrices = getPricesForCurrency(currency);
    const packKey = packType as keyof typeof AI_CREDITS_CONFIG.packs;
    const creditsCentsByPack: Record<keyof typeof AI_CREDITS_CONFIG.packs, number> = {
      small: currencyPrices.credits_small_cents,
      large: currencyPrices.credits_large_cents,
      bulk: currencyPrices.credits_bulk_cents
    };
    const creditsCents = creditsCentsByPack[packKey];

    const description = user.ui_language === 'es'
      ? `Pack de Créditos IA - ${selectedPack.credits} créditos`
      : `AI Credits Pack - ${selectedPack.credits} credits`;

    // Get billing country from payment method (collected during subscription signup)
    let billingCountry: string | null = null;
    try {
      const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
      billingCountry = (customer as any).address?.country || null;

      if (!billingCountry) {
        // Get country from payment method
        const invoicePm = (customer as any).invoice_settings?.default_payment_method;
        let pmId = invoicePm ? (typeof invoicePm === 'string' ? invoicePm : invoicePm.id) : null;
        if (!pmId) {
          const pms = await stripe.paymentMethods.list({ customer: customerId, limit: 1 });
          if (pms.data.length > 0) pmId = pms.data[0].id;
        }
        if (pmId) {
          const pm = await stripe.paymentMethods.retrieve(pmId);
          billingCountry = pm.billing_details?.address?.country || null;
        }
      }

      // Last resort: derive from user language
      if (!billingCountry && user.ui_language) {
        const langToCountry: Record<string, string> = { es: 'ES', en: 'US', fr: 'FR', de: 'DE', it: 'IT', pt: 'PT' };
        billingCountry = langToCountry[user.ui_language] || null;
      }
    } catch (e) {
      // Continue without tax
    }

    // Calculate tax using Stripe Tax Calculations API
    let totalAmountCents = creditsCents;
    let taxAmountCents = 0;
    if (billingCountry) {
      try {
        const taxCalc = await (stripe as any).tax.calculations.create({
          currency: currency.toLowerCase(),
          line_items: [{
            amount: creditsCents,
            reference: `ai_credits_${packType}`,
            tax_code: 'txcd_10000000', // General - Electronically Supplied Services
          }],
          customer_details: {
            address: { country: billingCountry },
            address_source: 'billing',
          },
        });
        totalAmountCents = taxCalc.amount_total;
        taxAmountCents = taxCalc.tax_amount_exclusive;
      } catch (e: any) {
        console.error('Tax calculation failed, proceeding without tax:', e.message);
        // Fall back to base amount
      }
    }

    // Create PaymentIntent with the tax-inclusive amount
    const paymentIntent = await stripe.paymentIntents.create({
      customer: customerId,
      amount: totalAmountCents,
      currency: currency.toLowerCase(),
      description,
      metadata: {
        user_id: userId,
        purchase_type: 'ai_credits',
        credits_amount: selectedPack.credits.toString(),
        pack: packType,
        tax_amount: taxAmountCents.toString(),
        billing_country: billingCountry || ''
      }
    });

    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      total_cents: totalAmountCents,
      tax_cents: taxAmountCents,
      currency: currency.toLowerCase()
    });
  } catch (error) {
    console.error('Error creating AI credits checkout:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * GET /api/ai-credits/transactions
 * Get AI credit transaction history
 */
router.get('/transactions', requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const limit = parseInt(req.query.limit as string) || 50;

    const pricingService = req.pricingService || new PricingService(getSupabaseClient());
    const transactions = await pricingService.getAICreditTransactions(userId, limit);

    res.json({ transactions });
  } catch (error) {
    console.error('Error getting AI credit transactions:', error);
    res.status(500).json({ error: 'Failed to get transaction history' });
  }
});

/**
 * POST /api/ai-credits/fulfill
 * Verify payment and fulfill AI credits purchase (called after checkout redirect)
 * This is the primary method - doesn't rely on webhooks
 */
router.post('/fulfill', requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { session_id, payment_intent_id } = req.body;
    if (!session_id && !payment_intent_id) {
      return res.status(400).json({ error: 'session_id or payment_intent_id required' });
    }

    const supabaseClient = getSupabaseClient();
    let creditsAmount: number;
    let idempotencyKey: Record<string, string>;

    if (payment_intent_id) {
      // Native Payment Element flow
      const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

      if (paymentIntent.metadata?.purchase_type !== 'ai_credits') {
        return res.status(400).json({ error: 'Invalid payment type' });
      }
      if (paymentIntent.metadata?.user_id !== userId) {
        return res.status(403).json({ error: 'Payment does not belong to this user' });
      }
      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ error: 'Payment not completed', payment_status: paymentIntent.status });
      }

      creditsAmount = parseInt(paymentIntent.metadata.credits_amount || '0', 10);
      idempotencyKey = { stripe_payment_intent_id: payment_intent_id };
    } else {
      // Legacy Checkout Session flow
      const session = await stripe.checkout.sessions.retrieve(session_id);

      if (session.metadata?.purchase_type !== 'ai_credits') {
        return res.status(400).json({ error: 'Invalid session type' });
      }
      if (session.metadata?.user_id !== userId) {
        return res.status(403).json({ error: 'Session does not belong to this user' });
      }
      if (session.payment_status !== 'paid') {
        return res.status(400).json({ error: 'Payment not completed', payment_status: session.payment_status });
      }

      creditsAmount = parseInt(session.metadata.credits_amount || '0', 10);
      idempotencyKey = { stripe_checkout_session_id: session_id };
    }

    // Check if already fulfilled (idempotency)
    const { data: existingTransaction } = await supabaseClient
      .from('ai_credit_transactions')
      .select('id')
      .eq('user_id', userId)
      .contains('metadata', idempotencyKey)
      .limit(1);

    if (existingTransaction && existingTransaction.length > 0) {
      const pricingService = req.pricingService || new PricingService(supabaseClient);
      const balance = await pricingService.getAICreditsBalance(userId);
      return res.json({
        success: true,
        already_fulfilled: true,
        balance,
        message: 'Credits already added'
      });
    }

    if (!creditsAmount || creditsAmount <= 0 || !Number.isFinite(creditsAmount)) {
      return res.status(400).json({ error: 'Invalid credits amount' });
    }

    const pricingService = req.pricingService || new PricingService(supabaseClient);
    await pricingService.addAICredits(userId, creditsAmount, 'AI Credits pack purchase', idempotencyKey);

    const newBalance = await pricingService.getAICreditsBalance(userId);

    res.json({
      success: true,
      credits_added: creditsAmount,
      balance: newBalance
    });
  } catch (error) {
    console.error('Error fulfilling AI credits purchase:', error);
    res.status(500).json({ error: 'Failed to fulfill purchase' });
  }
});

/**
 * GET /api/ai-credits/config
 * Get AI credits configuration (public info)
 */
router.get('/config', (req: Request, res: Response) => {
  res.json({
    pack: {
      credits: AI_CREDITS_CONFIG.pack.credits,
      price_dollars: AI_CREDITS_CONFIG.pack.priceDollars,
      currency: AI_CREDITS_CONFIG.pack.currency
    },
    packs: getPublicAICreditPacks(),
    costs: AI_CREDITS_CONFIG.costs,
    effective_costs: {
      image: getEffectiveCost('image'),
      video: getEffectiveCost('video'),
      creative: getEffectiveCost('creative')
    },
    launch_discount: AI_CREDITS_CONFIG.launchDiscount,
    requires_paid_plan: AI_CREDITS_CONFIG.requiresPaidPlan
  });
});

export default router;
