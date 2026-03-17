import Stripe from 'stripe';
import { supabase } from '../config/database';
import { getPlanIdFromStripePrice, getPlanById, AI_CREDITS_CONFIG } from '../config/pricingPlans';
import { PricingService } from './pricingService';

export class StripeWebhookService {
  
  async handleCustomerSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
    try {
      const customerId = subscription.customer as string;
      const status = subscription.status;
      
      // Access the timestamps using proper casting
      let endTimestamp = (subscription as any).current_period_end;
      let startTimestamp = (subscription as any).current_period_start;

      // If timestamps are missing from webhook, fetch full subscription from Stripe
      if (!endTimestamp || !startTimestamp) {
        try {
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
          const fullSubscription = await stripe.subscriptions.retrieve(subscription.id, {
            expand: ['latest_invoice']
          });
          endTimestamp = fullSubscription.current_period_end;
          startTimestamp = fullSubscription.current_period_start;

          // If still missing, try to use the subscription creation time and billing period
          if (!endTimestamp || !startTimestamp) {
            const createdAt = fullSubscription.created;
            const billingCycle = fullSubscription.items.data[0].price.recurring;
            
            if (billingCycle && createdAt) {
              startTimestamp = createdAt;
              // Calculate end based on billing interval
              const intervalUnit = billingCycle.interval; // 'month' or 'year'
              const intervalCount = billingCycle.interval_count || 1;
              
              const startDate = new Date(createdAt * 1000);
              let endDate = new Date(startDate);
              
              if (intervalUnit === 'month') {
                endDate.setMonth(endDate.getMonth() + intervalCount);
              } else if (intervalUnit === 'year') {
                endDate.setFullYear(endDate.getFullYear() + intervalCount);
              }
              
              endTimestamp = Math.floor(endDate.getTime() / 1000);
            }
          }
        } catch (stripeError) {
          console.error('Failed to fetch subscription from Stripe API:', stripeError);
        }
      }

      let currentPeriodEnd: Date | null = null;
      let currentPeriodStart: Date | null = null;

      if (endTimestamp && startTimestamp) {
        currentPeriodEnd = new Date(endTimestamp * 1000);
        currentPeriodStart = new Date(startTimestamp * 1000);

        if (isNaN(currentPeriodEnd.getTime()) || isNaN(currentPeriodStart.getTime())) {
          currentPeriodEnd = null;
          currentPeriodStart = null;
        }
      }
      
      // Find the base plan item (not an addon) from subscription items
      const { getAddonTypeFromPriceId } = require('../config/pricingPlans');
      const basePlanItemCreated = subscription.items.data.find((item: any) => {
        return getAddonTypeFromPriceId(item.price.id) === null;
      });
      const priceId = basePlanItemCreated?.price?.id || subscription.items.data[0].price.id;
      const planId = getPlanIdFromStripePrice(priceId);

      if (!planId) {
        console.error('Unknown Stripe price ID:', priceId);
        return;
      }

      // Get user ID from stripe customer ID
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single();
        
      if (userError || !user) {
        console.error('User not found for customer:', customerId);
        return;
      }

      // SECURITY FIX: Only update plan_id in user_subscriptions if subscription is active
      const subscriptionData: any = {
        user_id: user.id,
        status: status,
        stripe_subscription_id: subscription.id,
        current_period_start: currentPeriodStart ? currentPeriodStart.toISOString() : null,
        current_period_end: currentPeriodEnd ? currentPeriodEnd.toISOString() : null,
        cancel_at_period_end: subscription.cancel_at_period_end || false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Only set plan_id if subscription is actually paid/active
      if (status === 'active' || status === 'trialing') {
        subscriptionData.plan_id = planId;
      } else {
        // Keep current plan for incomplete subscriptions
        subscriptionData.plan_id = 'free';
      }

      const { error: subscriptionError } = await supabase
        .from('user_subscriptions')
        .upsert(subscriptionData, { 
          onConflict: 'user_id' 
        });

      if (subscriptionError) {
        console.error('Error updating user_subscriptions:', subscriptionError);
        throw subscriptionError;
      }

      // Only update Stripe IDs in users table (plan data is in user_subscriptions)
      const { error } = await supabase
        .from('users')
        .update({
          stripe_subscription_id: subscription.id,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_customer_id', customerId);

      if (error) {
        console.error('Error updating user:', error);
        throw error;
      }

      // Note: Launch offer credits are now granted in handleCheckoutSessionCompleted
      // when payment is confirmed, not here

    } catch (error) {
      console.error('Error handling subscription created:', error);
      throw error;
    }
  }

  async handleCustomerSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    try {
      const customerId = subscription.customer as string;
      const status = subscription.status;
      
      // Access the timestamps using proper casting
      let endTimestamp = (subscription as any).current_period_end;
      let startTimestamp = (subscription as any).current_period_start;

      // If timestamps are missing from webhook, fetch full subscription from Stripe
      if (!endTimestamp || !startTimestamp) {
        try {
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
          const fullSubscription = await stripe.subscriptions.retrieve(subscription.id);
          endTimestamp = fullSubscription.current_period_end;
          startTimestamp = fullSubscription.current_period_start;
        } catch (stripeError) {
          console.error('Failed to fetch subscription from Stripe API:', stripeError);
        }
      }

      let currentPeriodEnd: Date | null = null;
      let currentPeriodStart: Date | null = null;

      if (endTimestamp && startTimestamp) {
        currentPeriodEnd = new Date(endTimestamp * 1000);
        currentPeriodStart = new Date(startTimestamp * 1000);

        if (isNaN(currentPeriodEnd.getTime()) || isNaN(currentPeriodStart.getTime())) {
          currentPeriodEnd = null;
          currentPeriodStart = null;
        }
      }

      // Find the base plan item (not an addon) from subscription items
      const { getAddonTypeFromPriceId: getAddonType } = require('../config/pricingPlans');
      const basePlanItem = subscription.items.data.find(item => {
        const addonType = getAddonType(item.price.id);
        return addonType === null; // Not an addon = base plan
      });

      const priceId = basePlanItem?.price?.id || subscription.items.data[0].price.id;
      const planId = getPlanIdFromStripePrice(priceId);

      if (!planId) {
        console.error('Unknown Stripe price ID:', priceId);
        // Don't silently return - still process addon quantities
        // Fall back to reading current plan from user_subscriptions
      }

      // Extract addon quantities from subscription items
      // Note: AI credits are now one-time purchases, not subscription addons
      let additionalProjects = 0;
      let additionalCollaborators = 0;

      for (const item of subscription.items.data) {
        const itemPriceId = item.price.id;
        const quantity = item.quantity || 0;

        // Check if this is an addon price ID
        const { getAddonTypeFromPriceId } = require('../config/pricingPlans');
        const addonType = getAddonTypeFromPriceId(itemPriceId);

        if (addonType === 'additional_projects') {
          additionalProjects = quantity;
        } else if (addonType === 'additional_collaborators') {
          additionalCollaborators = quantity;
        }
        // Note: AI credits are not subscription addons anymore
      }

      // Get user ID from stripe customer ID
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single();
        
      if (userError || !user) {
        console.error('User not found for customer:', customerId);
        return;
      }

      // SECURITY FIX: Only update plan_id in user_subscriptions if subscription is active
      // Note: AI credits are not part of subscription anymore
      const subscriptionUpdateData: any = {
        user_id: user.id,
        status: status,
        stripe_subscription_id: subscription.id,
        current_period_start: currentPeriodStart ? currentPeriodStart.toISOString() : null,
        current_period_end: currentPeriodEnd ? currentPeriodEnd.toISOString() : null,
        cancel_at_period_end: subscription.cancel_at_period_end || false,
        additional_projects: additionalProjects,
        additional_collaborators: additionalCollaborators,
        updated_at: new Date().toISOString()
      };

      // Only set plan_id if subscription is actually paid/active
      if ((status === 'active' || status === 'trialing') && planId) {
        subscriptionUpdateData.plan_id = planId;
      } else {
        // Keep current plan - read from user_subscriptions (not users table)
        const { data: currentSub } = await supabase
          .from('user_subscriptions')
          .select('plan_id')
          .eq('user_id', user.id)
          .single();
        subscriptionUpdateData.plan_id = currentSub?.plan_id || (planId || 'free');
      }

      const { error: subscriptionError } = await supabase
        .from('user_subscriptions')
        .upsert(subscriptionUpdateData, { 
          onConflict: 'user_id' 
        });

      if (subscriptionError) {
        console.error('Error updating user_subscriptions:', subscriptionError);
        throw subscriptionError;
      }

      // Only update Stripe IDs in users table (plan data is in user_subscriptions)
      const { error } = await supabase
        .from('users')
        .update({
          stripe_subscription_id: subscription.id,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_customer_id', customerId);

      if (error) {
        console.error('Error updating user:', error);
        throw error;
      }

    } catch (error) {
      console.error('Error handling subscription updated:', error);
      throw error;
    }
  }

  async handleCustomerSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    try {
      const customerId = subscription.customer as string;

      // Get user ID first
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single();
        
      if (userError || !user) {
        console.error('User not found for customer:', customerId);
        return;
      }

      // Update user_subscriptions table to cancelled status (note: double 'l')
      // NOTE: AI credits are one-time purchases and persist even after cancellation
      const { error: subscriptionError } = await supabase
        .from('user_subscriptions')
        .upsert({
          user_id: user.id,
          plan_id: 'free',
          status: 'cancelled',
          stripe_subscription_id: null,
          current_period_start: null,
          current_period_end: null,
          cancel_at_period_end: false,
          additional_projects: 0, // Reset addons on cancellation
          additional_collaborators: 0, // Reset addons on cancellation
          // Note: AI credits in user_quotas.ai_credits_balance persist after cancellation
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id'
        });

      if (subscriptionError) {
        console.error('Error updating user_subscriptions on cancellation:', subscriptionError);
        throw subscriptionError;
      }

      // CRITICAL: Preserve stripe_customer_id when cancelling subscriptions
      // The customer should persist for future resubscriptions
      const { error } = await supabase
        .from('users')
        .update({
          stripe_subscription_id: null,
          updated_at: new Date().toISOString()
          // NOTE: NOT clearing stripe_customer_id - keep it for resubscription
          // NOTE: Plan data is in user_subscriptions table, not users
        })
        .eq('stripe_customer_id', customerId);

      if (error) {
        console.error('Error downgrading user to free plan:', error);
        throw error;
      }

    } catch (error) {
      console.error('Error handling subscription deleted:', error);
      throw error;
    }
  }

  async handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    try {
      const customerId = invoice.customer as string;
      const subscriptionId = (invoice as any).subscription as string;

      // Get user
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, email, current_plan')
        .eq('stripe_customer_id', customerId)
        .single();

      if (userError || !user) {
        console.error('User not found for customer:', customerId);
        return;
      }

      // NEW SYSTEM (January 2025):
      // - ai_generations_used is now a LIFETIME counter for FREE users only (never resets)
      // - PAID users use the credit system (ai_credits_balance) which is one-time purchases
      // - No need to reset ai_generations_used on subscription renewal anymore
      // - AI credits (ai_credits_balance) are also NOT reset - they are one-time purchases
      console.log(`✅ Invoice payment succeeded for user ${user.id} (email: ${user.email}) - no quota reset needed (paid users use credit system)`);


      // Note: AI credits are now one-time purchases via /api/ai-credits/purchase
      // They are handled in handleCheckoutSessionCompleted, not here

      // billing_history table deprecated - now using direct Stripe API integration
    } catch (error) {
      console.error('Error handling payment succeeded:', error);
      throw error;
    }
  }

  async handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    try {
      const customerId = invoice.customer as string;

      // Get user
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, email')
        .eq('stripe_customer_id', customerId)
        .single();

      if (userError || !user) {
        console.error('User not found for customer:', customerId);
        return;
      }

      // Update subscription status to past_due
      const { error } = await supabase
        .from('users')
        .update({
          subscription_status: 'past_due'
        })
        .eq('stripe_customer_id', customerId);

      if (error) {
        console.error('Error updating subscription status to past_due:', error);
        throw error;
      }

      // Create billing history record for failed payment with proper period handling
      let billingPeriodStart = null;
      let billingPeriodEnd = null;
      
      // Try to get period data from invoice
      if ((invoice as any).period_start && (invoice as any).period_end) {
        billingPeriodStart = new Date((invoice as any).period_start * 1000).toISOString();
        billingPeriodEnd = new Date((invoice as any).period_end * 1000).toISOString();
      } else if ((invoice as any).lines?.data?.length > 0) {
        // Try to get period data from line items
        const lineItem = (invoice as any).lines.data[0];
        if (lineItem.period?.start && lineItem.period?.end) {
          billingPeriodStart = new Date(lineItem.period.start * 1000).toISOString();
          billingPeriodEnd = new Date(lineItem.period.end * 1000).toISOString();
        }
      }
      
    } catch (error) {
      console.error('Error handling payment failed:', error);
      throw error;
    }
  }

  async handleInvoiceItemCreated(invoiceItem: Stripe.InvoiceItem): Promise<void> {
    try {
      const customerId = invoiceItem.customer as string;

      // Get user
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, email')
        .eq('stripe_customer_id', customerId)
        .single();

      if (userError || !user) {
        console.error('User not found for customer:', customerId);
        return;
      }

      // FIXED: Don't manually create invoices for subscription changes
      // Stripe handles proration automatically for subscription updates
      // Manual invoice creation was causing payment delays

      const isSubscriptionChange = invoiceItem.description && (
        invoiceItem.description.toLowerCase().includes('proration') ||
        invoiceItem.description.toLowerCase().includes('remaining time on') ||
        invoiceItem.description.toLowerCase().includes('unused time on') ||
        invoiceItem.description.toLowerCase().includes('after ')
      );

      if (isSubscriptionChange) {
        // No manual intervention needed - Stripe handles proration automatically
      }

    } catch (error) {
      console.error('Error handling invoice item created:', error);
      throw error;
    }
  }

  async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
    try {
      // IMPORTANT: Stripe webhooks may not include full metadata
      // Retrieve the complete session from Stripe to ensure we have all data
      let fullSession = session;
      if (!session.metadata || Object.keys(session.metadata).length === 0) {
        try {
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
          fullSession = await stripe.checkout.sessions.retrieve(session.id);
        } catch (stripeErr) {
          console.error('Failed to retrieve full session:', stripeErr);
        }
      }

      const customerId = fullSession.customer as string;
      const subscriptionId = fullSession.subscription as string;

      // Try multiple sources for user ID
      const userId = fullSession.metadata?.user_id ||
                    fullSession.metadata?.supabase_user_id ||
                    fullSession.client_reference_id;

      if (!userId) {
        console.error('No user_id found in checkout session');
        return;
      }

      // Re-assign session to fullSession for rest of function
      session = fullSession;

      // Update user's stripe_customer_id if not set
      if (customerId) {
        const { error: updateError } = await supabase
          .from('users')
          .update({ stripe_customer_id: customerId })
          .eq('id', userId);

        if (updateError) {
          console.error('Error updating user stripe_customer_id:', updateError);
        }
      }

      // Handle setup mode (payment method update)
      if (session.mode === 'setup' && session.metadata?.action_type === 'payment_method_update') {

        // Get the setup intent to find the new payment method
        const setupIntentId = session.setup_intent as string;
        if (setupIntentId) {
          try {
            const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
            const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
            const newPaymentMethodId = setupIntent.payment_method;

            // Attach payment method to customer's default (if not already)
            if (newPaymentMethodId) {
              await stripe.customers.update(customerId, {
                invoice_settings: {
                  default_payment_method: newPaymentMethodId
                }
              });
            }
          } catch (err) {
            console.error('Error updating payment method:', err);
          }
        }

        return; // Exit early for payment method updates
      }

      // Handle one-time AI credits purchase (backup - primary method is /api/ai-credits/fulfill)
      if (session.metadata?.purchase_type === 'ai_credits') {
        const creditsAmount = parseInt(session.metadata.credits_amount || '0');
        if (creditsAmount > 0) {
          // Check if already fulfilled by the fulfill endpoint (idempotency)
          const { data: existingTransaction } = await supabase
            .from('ai_credit_transactions')
            .select('id')
            .eq('user_id', userId)
            .contains('metadata', { stripe_checkout_session_id: session.id })
            .limit(1);

          if (!existingTransaction || existingTransaction.length === 0) {
            const pricingService = new PricingService(supabase);
            await pricingService.addAICredits(userId, creditsAmount, 'AI Credits pack purchase', {
              stripe_checkout_session_id: session.id,
              stripe_payment_intent_id: session.payment_intent as string
            });
          }
        }
        return; // Exit early for credit purchases
      }

      // Handle subscription creation
      if (subscriptionId && !session.metadata?.addon_type) {
        // Get the plan from metadata
        const planId = session.metadata?.plan_id || 'paid'; // default to paid (new pricing model)

        // Get the Stripe price ID from the subscription
        let stripePriceId = null;
        try {
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          stripePriceId = subscription.items.data[0]?.price?.id || null;
        } catch (err) {
          console.error('Could not retrieve Stripe price ID:', err);
        }

        // Update user subscription with complete Stripe data
        const { error: subscriptionError } = await supabase
          .from('user_subscriptions')
          .upsert({
            user_id: userId,
            plan_id: planId,
            status: 'active',
            stripe_subscription_id: subscriptionId,
            stripe_customer_id: customerId,
            stripe_plan_price_id: stripePriceId,
            current_period_start: new Date().toISOString(),
            current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
            cancel_at_period_end: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id' });

        // Also update users table with stripe_subscription_id
        await supabase
          .from('users')
          .update({ stripe_subscription_id: subscriptionId })
          .eq('id', userId);

        if (subscriptionError) {
          console.error('Error updating subscription:', subscriptionError);
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
              const pricingService = new PricingService(supabase);
              await pricingService.addAICredits(
                userId,
                200,
                '🎁 Launch offer: 200 free AI credits with subscription',
                { promotion: 'launch_offer', stripe_checkout_session_id: session.id }
              );
            }
          } catch {
            // Silent fail - don't block checkout for bonus credits
          }
        }

        return; // Exit early for subscription checkouts
      }

      // Check if this is an addon purchase
      const addonType = session.metadata?.addon_type;
      const quantity = session.metadata?.quantity;
      const billingType = session.metadata?.billing_type;

      if (addonType && quantity && (billingType === 'one_time_addon' || billingType === 'recurring_addon')) {
        // Map addon type from checkout metadata to database field
        const dbAddonType = addonType === 'projects' ? 'additional_projects' : 'additional_collaborators';

        // Get user's current plan from user_subscriptions (not users table)
        const { data: userSub } = await supabase
          .from('user_subscriptions')
          .select('plan_id')
          .eq('user_id', userId)
          .single();

        const planId = userSub?.plan_id || 'free';
        await this.handleAddonPurchase(userId, dbAddonType, parseInt(quantity), planId);
      }
      
      // TODO: Send welcome email or trigger onboarding flow
      // await sendWelcomeEmail(userId);
      
    } catch (error) {
      console.error('Error handling checkout session completed:', error);
      throw error;
    }
  }

  /**
   * Handle addon purchase from checkout session
   * Note: AI credits are now one-time purchases, handled separately in handleCheckoutSessionCompleted
   */
  async handleAddonPurchase(userId: string, addonType: string, quantity: number, planId: string): Promise<void> {
    try {
      // Get current subscription
      const { data: currentSubscription } = await supabase
        .from('user_subscriptions')
        .select('additional_projects, additional_collaborators')
        .eq('user_id', userId)
        .single();

      let updateField: string;
      let currentAdditional: number;

      if (addonType === 'additional_projects') {
        currentAdditional = currentSubscription?.additional_projects || 0;
        updateField = 'additional_projects';
      } else if (addonType === 'additional_collaborators') {
        currentAdditional = currentSubscription?.additional_collaborators || 0;
        updateField = 'additional_collaborators';
      } else {
        // Note: AI credits are now handled via handleCheckoutSessionCompleted with purchase_type='ai_credits'
        console.error('Unknown addon type:', addonType);
        return;
      }

      const newAdditionalValue = currentAdditional + quantity;

      // Update subscription with new addon quantity
      const { error: updateError } = await supabase
        .from('user_subscriptions')
        .update({
          [updateField]: newAdditionalValue,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);

      if (updateError) {
        console.error('Error updating subscription with addon:', updateError);
        throw updateError;
      }

      // Create transaction record
      const plan = getPlanById(planId);
      let addonConfig: any;
      let unitPrice: number;

      if (addonType === 'additional_projects') {
        addonConfig = plan?.addons?.additionalProjects;
        unitPrice = addonConfig?.pricePerProject || 0;
      } else if (addonType === 'additional_collaborators') {
        addonConfig = plan?.addons?.additionalCollaborators;
        unitPrice = addonConfig?.pricePerCollaborator || 0;
      } else {
        unitPrice = 0;
      }

      const { error: transactionError } = await supabase
        .from('addon_transactions')
        .insert({
          user_id: userId,
          addon_type: addonType,
          quantity: quantity,
          unit_price_cents: Math.round(unitPrice * 100),
          total_price_cents: Math.round(unitPrice * quantity * 100),
          currency: addonConfig?.currency || 'EUR',
          status: 'completed'
        });

      if (transactionError) {
        console.error('Error creating addon transaction record:', transactionError);
        // Don't throw - the subscription update is more important
      }

    } catch (error) {
      console.error('Error processing addon purchase:', error);
      throw error;
    }
  }

  async handleCustomerCreated(customer: Stripe.Customer): Promise<void> {
    try {
      const userId = customer.metadata?.supabase_user_id;

      if (!userId) {
        return;
      }

      // Update user with Stripe customer ID (in case it wasn't set during creation)
      const { error } = await supabase
        .from('users')
        .update({ stripe_customer_id: customer.id })
        .eq('id', userId);

      if (error) {
        console.error('Error updating user with customer ID:', error);
        throw error;
      }

    } catch (error) {
      console.error('Error handling customer created:', error);
      throw error;
    }
  }

  async handleChargeDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
    try {
      const customerId = (dispute.charge as any)?.customer;
      if (!customerId) return;

    } catch (error) {
      console.error('Error handling dispute created:', error);
      throw error;
    }
  }

  async handleRefundCreated(refund: Stripe.Refund): Promise<void> {
    try {

      // TODO: Log refund in database if needed for accounting
      // For now, Stripe dashboard provides sufficient tracking

    } catch (error) {
      console.error('Error handling refund created:', error);
      throw error;
    }
  }

  async processWebhookEvent(event: Stripe.Event): Promise<void> {
    try {
      switch (event.type) {
        case 'customer.created':
          await this.handleCustomerCreated(event.data.object as Stripe.Customer);
          break;
          
        case 'customer.subscription.created':
          await this.handleCustomerSubscriptionCreated(event.data.object as Stripe.Subscription);
          break;
          
        case 'customer.subscription.updated':
          await this.handleCustomerSubscriptionUpdated(event.data.object as Stripe.Subscription);
          break;
          
        case 'customer.subscription.deleted':
          await this.handleCustomerSubscriptionDeleted(event.data.object as Stripe.Subscription);
          break;
          
        case 'invoice.payment_succeeded':
          await this.handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
          break;
          
        case 'invoice.payment_failed':
          await this.handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
          break;
          
        case 'checkout.session.completed':
          await this.handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
          break;
          
        case 'invoiceitem.created':
          await this.handleInvoiceItemCreated(event.data.object as Stripe.InvoiceItem);
          break;

        case 'charge.dispute.created':
          await this.handleChargeDisputeCreated(event.data.object as Stripe.Dispute);
          break;

        case 'refund.created':
          await this.handleRefundCreated(event.data.object as Stripe.Refund);
          break;
      }
    } catch (error) {
      console.error(`Error processing webhook event ${event.type}:`, error);
      throw error;
    }
  }
}

export const stripeWebhookService = new StripeWebhookService();