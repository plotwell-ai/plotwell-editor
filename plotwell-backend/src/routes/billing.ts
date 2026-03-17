import express from 'express';
import { stripeService } from '../services/stripeService';
import { stripeWebhookService } from '../services/stripeWebhookService';

const router = express.Router();

/**
 * NOTE: Most billing endpoints have been moved to the unified billing system.
 * Use /api/billing endpoints from unifiedBilling.ts for new functionality.
 * This file now primarily handles webhook processing.
 */

/**
 * Webhook endpoint for Stripe events
 * This endpoint must handle raw body data for signature verification
 */
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  try {

    const signature = req.headers['stripe-signature'] as string;
    const payload = req.body;

    if (!signature) {
      console.error('❌ Missing Stripe signature');
      return res.status(400).json({ error: 'Missing signature' });
    }

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error('❌ No webhook secret in environment');
      return res.status(400).json({ error: 'No webhook secret configured' });
    }

    // Construct webhook event using Stripe service
    const event = await stripeService.constructWebhookEvent(
      payload.toString(),
      signature
    );

    // Process the webhook event
    await stripeWebhookService.processWebhookEvent(event);

    res.json({ received: true });
  } catch (error: any) {
    console.error('❌ Stripe webhook error:', error);
    console.error('❌ Error details:', error.message);
    res.status(400).json({ error: 'Webhook processing failed', details: error.message });
  }
});

export default router;