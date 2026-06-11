import Stripe from 'stripe';
import { supabase } from '../config/database';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-08-27.basil',
});

export interface CustomerData {
  id: string;
  email: string;
  stripe_customer_id?: string;
}

export interface SubscriptionData {
  id: string;
  customer: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items: {
    data: Array<{
      id: string;
      price: {
        id: string;
        lookup_key?: string;
      };
    }>;
  };
  metadata: Record<string, string>;
}

export class StripeService {

  /**
   * Get upcoming invoice for a subscription using the modern Stripe API
   */
  async getUpcomingInvoice(customerId: string, subscriptionId?: string): Promise<any | null> {
    try {
      // Modern Stripe API uses createPreview (POST /v1/invoices/create_preview)
      // This is the official way to preview the next invoice
      const params: any = {
        customer: customerId,
        preview_mode: 'next' // 'next' shows the upcoming invoice
      };

      // Add subscription ID if provided (recommended for accuracy)
      if (subscriptionId) {
        params.subscription = subscriptionId;
      }

      const preview = await (stripe.invoices as any).createPreview(params);

      return preview;
    } catch (error: any) {
      console.error('Error fetching upcoming invoice:', error);
      // Return null if no upcoming invoice (customer might not have active subscription)
      if (error.code === 'invoice_upcoming_none' || error.statusCode === 404 || error.type === 'StripeInvalidRequestError') {
        return null;
      }
      throw error;
    }
  }

  async createCustomer(userId: string, email: string): Promise<Stripe.Customer> {
    try {
      // First check if user already has a customer ID in database
      const { data: existingUser } = await supabase
        .from('users')
        .select('stripe_customer_id')
        .eq('id', userId)
        .single();

      if (existingUser?.stripe_customer_id) {
        try {
          // Verify the customer still exists in Stripe
          const existingCustomer = await stripe.customers.retrieve(existingUser.stripe_customer_id);
          if (existingCustomer && !(existingCustomer as any).deleted) {
            return existingCustomer as Stripe.Customer;
          }
        } catch (err) {
          // Customer doesn't exist in Stripe, clear stale ID and continue to create
          if (DEBUG_AI) console.log('Stored customer ID not found in Stripe, clearing and creating new customer');
          await supabase
            .from('users')
            .update({ stripe_customer_id: null })
            .eq('id', userId);
        }
      }

      // Check for existing customer by email in Stripe
      const existingCustomers = await stripe.customers.list({
        email: email,
        limit: 1
      });

      if (existingCustomers.data.length > 0 && !(existingCustomers.data[0] as any).deleted) {
        const existingCustomer = existingCustomers.data[0] as Stripe.Customer;

        // Use optimistic locking: only update if stripe_customer_id is null
        const { error: updateError } = await supabase
          .from('users')
          .update({ stripe_customer_id: existingCustomer.id })
          .eq('id', userId)
          .is('stripe_customer_id', null);

        // If update failed due to constraint, another process set it - fetch and return
        if (updateError) {
          const { data: updatedUser } = await supabase
            .from('users')
            .select('stripe_customer_id')
            .eq('id', userId)
            .single();

          if (updatedUser?.stripe_customer_id) {
            const customer = await stripe.customers.retrieve(updatedUser.stripe_customer_id);
            return customer as Stripe.Customer;
          }
        }

        return existingCustomer;
      }

      // Create new customer with idempotency key to prevent duplicates
      // Include timestamp so a new key is used if a previous customer was deleted
      const idempotencyKey = `create-customer-${userId}-${Date.now()}`;
      const customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId }
      }, {
        idempotencyKey
      });

      // Use optimistic locking: only update if stripe_customer_id is still null
      const { error: updateError } = await supabase
        .from('users')
        .update({ stripe_customer_id: customer.id })
        .eq('id', userId)
        .is('stripe_customer_id', null);

      if (updateError) {
        // Another process created a customer concurrently - fetch theirs
        const { data: updatedUser } = await supabase
          .from('users')
          .select('stripe_customer_id')
          .eq('id', userId)
          .single();

        if (updatedUser?.stripe_customer_id && updatedUser.stripe_customer_id !== customer.id) {
          // Return the customer that won the race
          const winningCustomer = await stripe.customers.retrieve(updatedUser.stripe_customer_id);
          return winningCustomer as Stripe.Customer;
        }
      }

      return customer;
    } catch (error) {
      console.error('Error creating Stripe customer:', error);
      throw error;
    }
  }

  async getOrCreateCustomer(userId: string): Promise<string> {
    try {
      // Get user's email and current customer ID
      const { data: user } = await supabase
        .from('users')
        .select('stripe_customer_id, email')
        .eq('id', userId)
        .single();

      if (!user?.email) {
        throw new Error('User email not found');
      }

      // Normalize email (trim whitespace, lowercase for searching)
      const normalizedEmail = user.email.trim().toLowerCase();

      // First, check if we already have a valid customer ID in database
      if (user.stripe_customer_id) {
        try {
          const existingCustomer = await stripe.customers.retrieve(user.stripe_customer_id);

          if (existingCustomer && !(existingCustomer as any).deleted && (existingCustomer as Stripe.Customer).email === user.email) {
            return user.stripe_customer_id;
          }
        } catch (stripeError: any) {
          console.error('Database customer ID not found in Stripe, clearing stale ID:', stripeError.message);
          // Clear the stale customer ID so a new one can be created
          await supabase
            .from('users')
            .update({ stripe_customer_id: null })
            .eq('id', userId);
        }
      }

      // Search by email to find existing customers (prevents duplicates)
      // Try both original email and normalized email search
      const exactEmailSearch = await stripe.customers.list({
        email: user.email,
        limit: 10
      });

      const normalizedEmailSearch = user.email.toLowerCase() !== user.email ?
        await stripe.customers.list({
          email: normalizedEmail,
          limit: 10
        }) : { data: [] };

      // Combine results and deduplicate
      const allCustomers = [...exactEmailSearch.data, ...normalizedEmailSearch.data];
      const uniqueCustomers = allCustomers.filter((customer, index, self) =>
        index === self.findIndex(c => c.id === customer.id)
      );

      // Find the best matching non-deleted customer
      // Priority: 1) Exact email match, 2) Case-insensitive match, 3) Normalized match
      const exactMatch = uniqueCustomers.find(c =>
        !(c as any).deleted && (c as Stripe.Customer).email === user.email
      ) as Stripe.Customer;

      const caseInsensitiveMatch = uniqueCustomers.find(c =>
        !(c as any).deleted && (c as Stripe.Customer).email?.toLowerCase() === normalizedEmail
      ) as Stripe.Customer;

      const existingCustomer = exactMatch || caseInsensitiveMatch;

      if (existingCustomer) {
        // Update our database with the existing customer ID (in case it was cleared or different)
        if (user.stripe_customer_id !== existingCustomer.id) {
          const { error: updateError } = await supabase
            .from('users')
            .update({ stripe_customer_id: existingCustomer.id })
            .eq('id', userId);

          if (updateError) {
            console.error('Error updating user with existing customer ID:', updateError);
            // Don't throw - we can still use the existing customer
          }
        }

        return existingCustomer.id;
      }

      // Only create new customer if no valid customer exists with this email
      const customer = await this.createCustomer(userId, user.email);

      return customer.id;
    } catch (error) {
      console.error('Error getting/creating customer:', error);
      throw error;
    }
  }

  async createCheckoutSession(userId: string, priceId: string, metadata?: Record<string, string>, embedded?: boolean, currency?: string, billingCycle?: 'monthly' | 'yearly'): Promise<Stripe.Checkout.Session> {
    try {
      const customerId = await this.getOrCreateCustomer(userId);

      // Fetch user's preferred language for Stripe locale
      const { data: userData } = await supabase
        .from('users')
        .select('ui_language')
        .eq('id', userId)
        .single();
      const stripeLocale = (userData?.ui_language === 'es' ? 'es' : 'en') as Stripe.Checkout.SessionCreateParams.Locale;

      // CRITICAL: Clean up any existing incomplete/duplicate subscriptions first
      await this.cancelDuplicateSubscriptions(customerId);

      // CRITICAL FIX: Also expire any existing incomplete checkout sessions to prevent "multiple embedded checkout" error
      await this.expireIncompleteCheckoutSessions(customerId);

      // Check if user has existing active subscription (after cleanup)
      const { isActiveStatus } = require('../utils/subscriptionHelpers');
      const subscriptionStatus = await this.getSubscriptionStatus(userId);
      const hasActiveSubscription = subscriptionStatus.stripe_subscription_id &&
                                   isActiveStatus(subscriptionStatus.subscription_status);

      let sessionConfig: Stripe.Checkout.SessionCreateParams;

      // Trial config — driven by ONBOARDING_MODE env var
      // 'trial_7d' → offer trial to new users; 'freemium' → no trial (default)
      const onboardingMode = process.env.ONBOARDING_MODE || 'freemium';
      const FREE_TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);
      const trialEnabled = onboardingMode === 'trial_7d';

      // Only offer trial to truly new users (never had a subscription before)
      // Check both DB and Stripe to be safe
      let hadPreviousSubscription = false;
      const { data: subRecord } = await supabase
        .from('user_subscriptions')
        .select('status')
        .eq('user_id', userId)
        .maybeSingle();
      if (subRecord?.status === 'cancelled') {
        hadPreviousSubscription = true;
      }
      // Also check Stripe for any past subscriptions (cancelled, incomplete, etc.)
      if (!hadPreviousSubscription && customerId) {
        try {
          const allSubs = await stripe.subscriptions.list({
            customer: customerId,
            limit: 1,
            status: 'all'
          });
          if (allSubs.data.length > 0) {
            hadPreviousSubscription = true;
          }
        } catch (err) {
          console.error('⚠️ Error checking Stripe subscription history:', err);
        }
      }
      const eligibleForTrial = trialEnabled && !hasActiveSubscription && !hadPreviousSubscription;

      // Base config for embedded or hosted checkout
      const baseConfig: Stripe.Checkout.SessionCreateParams = {
        locale: stripeLocale,
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'subscription',
        // Add free trial only when ONBOARDING_MODE=trial_7d and user is new
        ...(eligibleForTrial && {
          subscription_data: {
            trial_period_days: FREE_TRIAL_DAYS,
          },
        }),
        metadata: {
          user_id: userId,
          action_type: hasActiveSubscription ? 'subscription_change' : 'new_subscription',
          ...(hasActiveSubscription && { existing_subscription_id: subscriptionStatus.stripe_subscription_id }),
          ...metadata
        },
        allow_promotion_codes: true,
        automatic_tax: { enabled: true },
        billing_address_collection: 'required',
        tax_id_collection: {
          enabled: true,
        },
        customer_update: {
          name: 'auto',
          address: 'auto',
        },
        // Multi-currency: tell Stripe which currency to use from the Price's currency_options
        ...(currency && { currency: currency.toLowerCase() }),
      };

      if (embedded) {
        // Embedded checkout configuration
        sessionConfig = {
          ...baseConfig,
          ui_mode: 'embedded',
          return_url: `${process.env.FRONTEND_URL}/projects?subscription_success=true&session_id={CHECKOUT_SESSION_ID}`,
        };
      } else {
        // Traditional hosted checkout configuration
        sessionConfig = {
          ...baseConfig,
          success_url: `${process.env.FRONTEND_URL}/projects?subscription_success=true&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.FRONTEND_URL}/projects?view=plans`,
        };
      }

      // Note: proration_behavior is NOT set here because this checkout session
      // always creates a new subscription (duplicate subscriptions are cleaned up above).
      // proration_behavior requires an existing billing_cycle_anchor which doesn't exist
      // for new subscriptions created via checkout.

      // Use idempotency key to prevent duplicate sessions from rapid clicks
      const idempotencyKey = `checkout-${userId}-${priceId}-${Date.now().toString().slice(0, -3)}`; // Truncate to nearest second
      try {
        const session = await stripe.checkout.sessions.create(sessionConfig, {
          idempotencyKey
        });
        // Attach trial eligibility so callers can pass it to the frontend
        (session as any)._hasTrial = eligibleForTrial;
        return session;
      } catch (stripeError: any) {
        // If currency is not supported by the Price (missing currency_options), retry without it
        if (currency && stripeError?.param === 'line_items[0][price]' && stripeError?.message?.includes('currency')) {
          console.warn(`⚠️ Price ${priceId} doesn't support currency ${currency}, falling back to base currency`);
          delete (sessionConfig as any).currency;
          const retryKey = `checkout-${userId}-${priceId}-fallback-${Date.now().toString().slice(0, -3)}`;
          const session = await stripe.checkout.sessions.create(sessionConfig, {
            idempotencyKey: retryKey
          });
          return session;
        }
        throw stripeError;
      }
    } catch (error) {
      console.error('Error creating checkout session:', error);
      throw error;
    }
  }

  async createPortalSession(userId: string): Promise<Stripe.BillingPortal.Session> {
    try {
      const customerId = await this.getOrCreateCustomer(userId);

      // Fetch user's preferred language for Stripe locale
      const { data: userData } = await supabase
        .from('users')
        .select('ui_language')
        .eq('id', userId)
        .single();
      const portalLocale = userData?.ui_language === 'es' ? 'es' : 'en';

      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        locale: portalLocale,
        return_url: `${process.env.FRONTEND_URL}/settings/billing`,
      });

      return session;
    } catch (error) {
      console.error('Error creating portal session:', error);
      throw error;
    }
  }

  async updateSubscription(userId: string, newPriceId: string): Promise<Stripe.Subscription> {
    try {
      // Get user's Stripe customer and subscription info
      const { data: user } = await supabase
        .from('users')
        .select('stripe_customer_id, stripe_subscription_id')
        .eq('id', userId)
        .single();

      if (!user?.stripe_subscription_id) {
        throw new Error('No active subscription found for user');
      }

      // Get the current subscription from Stripe
      const subscription = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
      
      if (!subscription || subscription.status !== 'active') {
        throw new Error('No active subscription found in Stripe');
      }

      // Update the subscription with the new price
      // This will handle proration automatically
      // Use idempotency key to prevent duplicate updates from rapid clicks
      const idempotencyKey = `update-sub-${userId}-${newPriceId}-${Date.now().toString().slice(0, -3)}`;
      const updatedSubscription = await stripe.subscriptions.update(user.stripe_subscription_id, {
        items: [{
          id: subscription.items.data[0].id,
          price: newPriceId,
        }],
        proration_behavior: 'create_prorations', // Create prorations for the upgrade
      }, {
        idempotencyKey
      });

      return updatedSubscription;
    } catch (error) {
      console.error('Error updating subscription:', error);
      throw error;
    }
  }

  async getSubscriptionStatus(userId: string): Promise<any> {
    const { isActiveStatus } = require('../utils/subscriptionHelpers');
    const { getPlanIdFromStripePrice } = require('../config/pricingPlans');

    try {
      // Get Stripe IDs from users table
      const { data: user } = await supabase
        .from('users')
        .select('stripe_customer_id, stripe_subscription_id')
        .eq('id', userId)
        .single();

      // Get DB state (unfiltered - need to see actual state for sync)
      const { data: userSub } = await supabase
        .from('user_subscriptions')
        .select('plan_id, status, current_period_end, current_period_start, cancel_at_period_end')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const FREE_RESULT = {
        plan_id: 'free',
        subscription_status: 'active',
        current_period_end: null,
        current_period_start: null,
        cancel_at_period_end: false,
        stripe_customer_id: user?.stripe_customer_id || null,
        stripe_subscription_id: null
      };

      if (!user?.stripe_customer_id) return FREE_RESULT;

      // ── Single Stripe fetch: active + trialing ──
      let stripeSubscriptions: any[] = [];
      try {
        const [activeSubs, trialingSubs] = await Promise.all([
          stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'active', limit: 10 }),
          stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'trialing', limit: 10 }),
        ]);
        stripeSubscriptions = [...activeSubs.data, ...trialingSubs.data];
      } catch (stripeError) {
        console.error('Error fetching Stripe subscriptions:', stripeError);
      }

      // No subscriptions in Stripe → downgrade DB if needed
      if (stripeSubscriptions.length === 0) {
        if (userSub && userSub.plan_id !== 'free') {
          if (DEBUG_AI) console.log(`⚠️ Stripe has no subscription for user ${userId} but DB says plan_id=${userSub.plan_id} - downgrading`);
          await supabase
            .from('user_subscriptions')
            .update({ plan_id: 'free', status: 'cancelled', cancel_at_period_end: false, additional_projects: 0, additional_collaborators: 0, updated_at: new Date().toISOString() })
            .eq('user_id', userId);
          return { ...FREE_RESULT, subscription_status: 'cancelled' };
        }
        return FREE_RESULT;
      }

      // Pick the newest subscription if duplicates exist
      if (stripeSubscriptions.length > 1) {
        console.error('Multiple subscriptions detected for customer:', user.stripe_customer_id);
        stripeSubscriptions.sort((a: any, b: any) => b.created - a.created);
      }
      const subscription = stripeSubscriptions[0];

      // Extract dates
      const currentPeriodEnd = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : userSub?.current_period_end || null;
      const currentPeriodStart = subscription.current_period_start
        ? new Date(subscription.current_period_start * 1000).toISOString()
        : userSub?.current_period_start || null;

      // Detect plan from subscription items
      let detectedPlanId = userSub?.plan_id || 'free';
      for (const item of subscription.items.data) {
        const mapped = getPlanIdFromStripePrice(item.price?.id);
        if (mapped) { detectedPlanId = mapped; break; }
      }

      // Sync DB if plan or status differs
      const stripeStatus = isActiveStatus(subscription.status) ? subscription.status : 'active';
      if (detectedPlanId !== userSub?.plan_id || stripeStatus !== userSub?.status) {
        await supabase
          .from('user_subscriptions')
          .upsert({
            user_id: userId,
            plan_id: detectedPlanId,
            status: stripeStatus,
            current_period_end: currentPeriodEnd,
            current_period_start: currentPeriodStart,
            cancel_at_period_end: subscription.cancel_at_period_end || false,
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id' });
      }

      return {
        plan_id: detectedPlanId,
        subscription_status: stripeStatus,
        current_period_end: currentPeriodEnd,
        current_period_start: currentPeriodStart,
        cancel_at_period_end: subscription.cancel_at_period_end || false,
        stripe_customer_id: user.stripe_customer_id,
        stripe_subscription_id: subscription.id
      };
    } catch (error) {
      console.error('Error getting subscription status:', error);
      throw error;
    }
  }

  async retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    try {
      return await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price']
      });
    } catch (error) {
      console.error('Error retrieving subscription:', error);
      throw error;
    }
  }


  async createUsageRecord(subscriptionItemId: string, quantity: number, timestamp?: number): Promise<any> {
    try {
      // Note: Usage records are for metered billing - simplified for now
      const usageRecord = await stripe.subscriptionItems.retrieve(subscriptionItemId);
      return { id: subscriptionItemId, quantity };
    } catch (error) {
      console.error('Error creating usage record:', error);
      throw error;
    }
  }

  async cancelSubscription(subscriptionId: string, cancelAtPeriodEnd: boolean = true): Promise<Stripe.Subscription> {
    try {
      if (cancelAtPeriodEnd) {
        return await stripe.subscriptions.update(subscriptionId, {
          cancel_at_period_end: true
        });
      } else {
        return await stripe.subscriptions.cancel(subscriptionId);
      }
    } catch (error) {
      console.error('Error canceling subscription:', error);
      throw error;
    }
  }

  async constructWebhookEvent(payload: string, signature: string): Promise<Stripe.Event> {
    try {
      return stripe.webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (error) {
      console.error('Error constructing webhook event:', error);
      throw error;
    }
  }

  // Helper method to get current usage from Stripe
  async getCurrentUsage(subscriptionItemId: string, startDate: number, endDate: number): Promise<any[]> {
    try {
      // Simplified for now - in production you'd use proper usage record APIs
      const subscriptionItem = await stripe.subscriptionItems.retrieve(subscriptionItemId);
      return [{ subscription_item: subscriptionItemId, total_usage: 0 }];
    } catch (error) {
      console.error('Error getting current usage:', error);
      throw error;
    }
  }

  // Method to create invoice item for one-time charges (project reactivation)
  async createInvoiceItem(customerId: string, amount: number, description: string, currency: string = 'usd'): Promise<Stripe.InvoiceItem> {
    try {
      return await stripe.invoiceItems.create({
        customer: customerId,
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        description,
      });
    } catch (error) {
      console.error('Error creating invoice item:', error);
      throw error;
    }
  }

  // Method to issue credit for plan upgrades
  async issueCreditInvoiceItem(customerId: string, creditAmount: number, description: string, currency: string = 'usd'): Promise<Stripe.InvoiceItem> {
    try {
      return await stripe.invoiceItems.create({
        customer: customerId,
        amount: Math.round(-creditAmount * 100), // Negative amount = credit
        currency: currency.toLowerCase(),
        description,
      });
    } catch (error) {
      console.error('Error issuing credit:', error);
      throw error;
    }
  }

  // Method to process refunds for downgrades to free
  async processRefundForSubscription(subscriptionId: string, refundAmount: number, userId: string, reason: string): Promise<{ refund: Stripe.Refund | null; amount: number }> {
    try {
      // Get the subscription with its latest invoice
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['latest_invoice']
      });

      if (!subscription.latest_invoice || typeof subscription.latest_invoice !== 'object') {
        return { refund: null, amount: 0 };
      }

      const latestInvoice = subscription.latest_invoice as Stripe.Invoice;

      const paymentIntent = (latestInvoice as any).payment_intent;

      if (!paymentIntent || latestInvoice.status !== 'paid') {
        return { refund: null, amount: 0 };
      }

      const refund = await stripe.refunds.create({
        payment_intent: paymentIntent as string,
        amount: Math.round(refundAmount * 100), // Convert to cents
        reason: 'requested_by_customer',
        metadata: {
          user_id: userId,
          reason: reason,
          subscription_id: subscriptionId
        }
      });

      const actualRefundAmount = refund.amount / 100; // Convert back to dollars

      return { refund, amount: actualRefundAmount };
    } catch (error) {
      console.error('❌ Error processing refund:', error);
      return { refund: null, amount: 0 };
    }
  }

  // EMERGENCY: Method to cancel duplicate subscriptions
  async cancelDuplicateSubscriptions(customerId: string): Promise<void> {
    try {
      const allSubscriptions = await stripe.subscriptions.list({
        customer: customerId,
        limit: 20,
      });

      // Cancel all non-terminal subscriptions (we're about to create a fresh one)
      const toCancel = allSubscriptions.data.filter((sub: any) =>
        ['active', 'trialing', 'incomplete', 'past_due'].includes(sub.status)
      );

      for (const subscription of toCancel) {
        try {
          await stripe.subscriptions.cancel(subscription.id);
          if (DEBUG_AI) console.log(`✅ Cancelled subscription ${subscription.id} (status: ${subscription.status})`);
        } catch (cancelError) {
          console.error('Failed to cancel subscription:', subscription.id, cancelError);
        }
      }
    } catch (error) {
      console.error('Error in subscription cleanup:', error);
    }
  }

  /**
   * Delete a Stripe customer and cancel all their subscriptions
   * Used when a user deletes their account
   * @param customerId - The Stripe customer ID
   * @returns Object with cancellation results
   */
  async deleteCustomerAndSubscriptions(customerId: string): Promise<{
    subscriptionsCancelled: number;
    customerDeleted: boolean;
    errors: string[];
  }> {
    const result = {
      subscriptionsCancelled: 0,
      customerDeleted: false,
      errors: [] as string[]
    };

    try {
      // Step 1: Cancel ALL subscriptions for this customer (including ones not in our DB)
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        limit: 100 // Get all subscriptions
      });

      for (const subscription of subscriptions.data) {
        // Only cancel active, trialing, or past_due subscriptions
        if (['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status)) {
          try {
            await stripe.subscriptions.cancel(subscription.id);
            result.subscriptionsCancelled++;
            if (DEBUG_AI) console.log(`✅ Cancelled subscription: ${subscription.id}`);
          } catch (cancelError: any) {
            const errorMsg = `Failed to cancel subscription ${subscription.id}: ${cancelError.message}`;
            console.error(`⚠️ ${errorMsg}`);
            result.errors.push(errorMsg);
          }
        }
      }

      // Step 2: Delete the Stripe customer
      // This will also cancel any remaining subscriptions and prevent future charges
      try {
        await stripe.customers.del(customerId);
        result.customerDeleted = true;
        if (DEBUG_AI) console.log(`✅ Deleted Stripe customer: ${customerId}`);
      } catch (deleteError: any) {
        const errorMsg = `Failed to delete customer ${customerId}: ${deleteError.message}`;
        console.error(`⚠️ ${errorMsg}`);
        result.errors.push(errorMsg);
      }

      return result;
    } catch (error: any) {
      console.error('❌ Error in deleteCustomerAndSubscriptions:', error);
      result.errors.push(`General error: ${error.message}`);
      return result;
    }
  }

  // Method to expire incomplete checkout sessions (prevents "multiple embedded checkout" error)
  async expireIncompleteCheckoutSessions(customerId: string): Promise<void> {
    try {
      if (!customerId) {
        console.warn('⚠️ Cannot expire checkout sessions: no customerId provided');
        return;
      }

      if (DEBUG_AI) console.log(`🔍 Fetching checkout sessions for customer ${customerId}...`);
      // Get all recent checkout sessions for this customer
      const checkoutSessions = await stripe.checkout.sessions.list({
        customer: customerId,
        limit: 20
      });

      if (DEBUG_AI) console.log(`📊 Found ${checkoutSessions.data.length} checkout session(s) for customer ${customerId}`);

      // Filter for open/incomplete sessions
      const incompleteSessionsToExpire = checkoutSessions.data.filter((session: any) =>
        session.status === 'open' && session.payment_status !== 'paid'
      );

      if (incompleteSessionsToExpire.length === 0) {
        if (DEBUG_AI) console.log(`ℹ️ No incomplete checkout sessions to expire for customer ${customerId}`);
        return;
      }

      if (DEBUG_AI) console.log(`⏱️  Expiring ${incompleteSessionsToExpire.length} incomplete session(s)...`);

      // Expire each incomplete session
      for (const session of incompleteSessionsToExpire) {
        try {
          await stripe.checkout.sessions.expire(session.id);
          if (DEBUG_AI) console.log(`✅ Expired checkout session ${session.id}`);
        } catch (expireError: any) {
          // If already expired or completed, that's fine - ignore silently
          if (expireError.code === 'resource_missing' || expireError.code === 'checkout_session_already_expired') {
            if (DEBUG_AI) console.log(`ℹ️ Checkout session ${session.id} already expired or not found`);
          } else {
            console.error('❌ Failed to expire session:', {
              session_id: session.id,
              error: expireError.message,
              error_code: expireError.code
            });
          }
        }
      }

    } catch (error: any) {
      console.error('❌ Error cleaning up checkout sessions:', {
        customer_id: customerId,
        error: error.message,
        error_type: error.type
      });
      // Don't throw - this is a cleanup operation, not critical to fail the entire flow
    }
  }

  /**
   * Cancel incomplete/pending subscriptions for a customer
   * Used by clear-checkout to reset trial eligibility when user retries payment
   */
  async cancelIncompleteSubscriptions(customerId: string): Promise<void> {
    try {
      if (!customerId) {
        if (DEBUG_AI) console.warn('⚠️ Cannot cancel incomplete subscriptions: no customerId provided');
        return;
      }

      // Get all incomplete subscriptions for this customer
      const incompleteSubscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'incomplete',
        limit: 10
      });

      if (incompleteSubscriptions.data.length === 0) {
        if (DEBUG_AI) console.log(`ℹ️ No incomplete subscriptions found for customer ${customerId}`);
        return;
      }

      if (DEBUG_AI) console.log(`🔄 Found ${incompleteSubscriptions.data.length} incomplete subscription(s) for customer ${customerId}`);

      // Cancel each incomplete subscription
      for (const subscription of incompleteSubscriptions.data) {
        try {
          const cancelled = await stripe.subscriptions.cancel(subscription.id);
          if (DEBUG_AI) console.log(`✅ Cancelled incomplete subscription ${subscription.id}`, {
            customer: customerId,
            status_was: subscription.status
          });
        } catch (cancelError: any) {
          // If already cancelled or doesn't exist, that's fine
          if (cancelError.code === 'resource_missing') {
            if (DEBUG_AI) console.log(`ℹ️ Subscription ${subscription.id} already deleted`);
          } else {
            console.error('❌ Failed to cancel subscription:', {
              subscription_id: subscription.id,
              customer_id: customerId,
              error: cancelError.message,
              error_code: cancelError.code
            });
            // Don't throw - this is a cleanup operation
          }
        }
      }
    } catch (error: any) {
      console.error('❌ Error cleaning up incomplete subscriptions:', {
        customer_id: customerId,
        error: error.message,
        error_type: error.type
      });
      // Don't throw - this is a cleanup operation, not critical to fail the entire flow
    }
  }

  /**
   * Check if a user is eligible for a free trial
   * Returns true if user has never had a subscription before
   */
  async checkTrialEligibility(userId: string): Promise<boolean> {
    try {
      // Check DB for previous subscription that was actually used.
      // NOTE: every new user gets plan_id='free', status='active' from the DB trigger on signup,
      // so we must check plan_id too — a free-plan row is never a real subscription.
      // A user loses trial eligibility only if they previously had (or have) a paid subscription.
      const { data: subRecord } = await supabase
        .from('user_subscriptions')
        .select('status, plan_id')
        .eq('user_id', userId)
        .maybeSingle();

      if (DEBUG_AI) console.log(`🔍 DB subscription check for ${userId.slice(0, 8)}***:`, { status: subRecord?.status || 'no record', plan_id: subRecord?.plan_id || 'none' });

      const hasPaidHistory = subRecord?.plan_id && subRecord.plan_id !== 'free';
      if (hasPaidHistory && subRecord?.status && ['cancelled', 'active', 'trialing', 'past_due'].includes(subRecord.status)) {
        if (DEBUG_AI) console.log(`ℹ️ User ${userId.slice(0, 8)}*** has paid subscription (status='${subRecord.status}'), not eligible for trial`);
        return false;
      }
      // 'cancelled' with plan_id='free' means the cancel flow reset them after a paid sub — still not eligible
      if (subRecord?.status === 'cancelled') {
        if (DEBUG_AI) console.log(`ℹ️ User ${userId.slice(0, 8)}*** has cancelled status, not eligible for trial`);
        return false;
      }

      // Also check Stripe for past subscriptions that were actually used
      // Ignore 'incomplete' and 'incomplete_expired' — those are from failed checkout attempts
      const customerId = await this.getOrCreateCustomer(userId);
      try {
        const allSubs = await stripe.subscriptions.list({
          customer: customerId,
          limit: 100,
          status: 'all'
        });
        const meaningfulSubs = allSubs.data.filter(sub =>
          !['incomplete', 'incomplete_expired'].includes(sub.status)
        );
        if (DEBUG_AI) console.log(`🔍 Stripe subscription check for ${userId.slice(0, 8)}***:`, {
          total: allSubs.data.length,
          meaningful: meaningfulSubs.length,
          statuses: allSubs.data.map(s => s.status)
        });
        if (meaningfulSubs.length > 0) {
          if (DEBUG_AI) console.log(`ℹ️ User ${userId.slice(0, 8)}*** has real subscription history (${meaningfulSubs.map(s => s.status).join(', ')}), not eligible for trial`);
          return false;
        }
      } catch (err) {
        console.error('⚠️ Error checking Stripe subscription history:', err);
      }

      if (DEBUG_AI) console.log(`✅ User ${userId.slice(0, 8)}*** is eligible for free trial`);
      return true;
    } catch (error) {
      console.error('Error checking trial eligibility:', error);
      return false; // Default to no trial on error
    }
  }

  /**
   * Create a Payment Element flow: Subscription without trial
   * Returns the PaymentIntent client_secret for Payment Element UI
   */
  /**
   * Create a SetupIntent for Payment Element flow
   * Used for both trial and non-trial subscriptions
   * Subscription is created after setup completes (in verify-payment)
   */
  async createSetupIntent(
    userId: string,
    priceId: string,
    hasTrial: boolean,
    metadata?: Record<string, string>
  ): Promise<{ client_secret: string; setup_intent_id: string }> {
    const customerId = await this.getOrCreateCustomer(userId);
    // Don't cancel existing subscriptions here — the user is just setting up a payment method.
    // Cleanup happens in createSubscriptionAfterSetupIntent right before creating the new sub.
    await this.expireIncompleteCheckoutSessions(customerId);

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      metadata: {
        user_id: userId,
        action_type: hasTrial ? 'new_subscription_with_trial' : 'new_subscription',
        price_id: priceId,
        has_trial: hasTrial ? 'true' : 'false',
        ...metadata
      },
      usage: 'off_session'
    });

    return {
      client_secret: setupIntent.client_secret!,
      setup_intent_id: setupIntent.id
    };
  }

  /**
   * Complete a subscription after setup intent is confirmed
   * Called from verify-payment endpoint when setup_intent_id is provided
   */
  async createSubscriptionAfterSetupIntent(
    setupIntentId: string,
    priceId: string,
    userId: string,
    trialDays?: number,
    metadata?: Record<string, string>,
    // Optional: provide explicit items array (e.g. multi-addon first purchase).
    // When provided, priceId is only used for tax lookup; items drives the subscription.
    extraItems?: Array<{ priceId: string; quantity: number }>
  ): Promise<Stripe.Subscription> {
    const customerId = await this.getOrCreateCustomer(userId);

    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    if (setupIntent.status !== 'succeeded') {
      throw new Error(`SetupIntent status is ${setupIntent.status}, expected succeeded`);
    }
    if (!setupIntent.payment_method) {
      throw new Error('SetupIntent does not have a payment method attached');
    }

    // Idempotency: check if a subscription was already created from this SetupIntent
    // This prevents duplicates when the frontend retries after a DB error
    try {
      const existingSubs = await stripe.subscriptions.list({
        customer: customerId,
        limit: 10,
      });
      const existingFromSetup = existingSubs.data.find(
        (sub: any) => sub.metadata?.setup_intent_id === setupIntentId &&
          ['active', 'trialing', 'incomplete'].includes(sub.status)
      );
      if (existingFromSetup) {
        if (DEBUG_AI) console.log(`♻️ Found existing subscription ${existingFromSetup.id} from SetupIntent ${setupIntentId}, reusing`);
        return existingFromSetup;
      }
    } catch (e) {
      // Continue to create if lookup fails
    }

    // Cancel old subscriptions right before creating the new one
    await this.cancelDuplicateSubscriptions(customerId);

    // Copy billing address from PM to customer so automatic_tax works
    let hasAddress = false;
    try {
      const pm = await stripe.paymentMethods.retrieve(setupIntent.payment_method as string);
      const pmCountry = pm.billing_details?.address?.country;
      if (pmCountry) {
        const addr: any = { country: pmCountry, line1: '' };
        const a = pm.billing_details?.address;
        if (a?.city) addr.city = a.city;
        if (a?.state) addr.state = a.state;
        if (a?.postal_code) addr.postal_code = a.postal_code;
        if (a?.line1) addr.line1 = a.line1;
        if (a?.line2) addr.line2 = a.line2;
        await stripe.customers.update(customerId, { address: addr });
        hasAddress = true;
      }
    } catch (e) { /* proceed without tax */ }

    // Fetch price details so we can set tax_behavior and currency
    const priceObj = await stripe.prices.retrieve(priceId);

    // Build subscription items — either the explicit extraItems list or just the primary price
    const allItems = extraItems && extraItems.length > 0 ? extraItems : [{ priceId, quantity: 1 }];
    const resolvedItems = await Promise.all(allItems.map(async (item) => {
      const p = item.priceId === priceId ? priceObj : await stripe.prices.retrieve(item.priceId);
      return {
        price_data: {
          currency: p.currency,
          product: typeof p.product === 'string' ? p.product : (p.product as any).id,
          unit_amount: p.unit_amount!,
          recurring: { interval: (p.recurring as any).interval, interval_count: (p.recurring as any).interval_count || 1 },
          tax_behavior: 'exclusive' as const,
        },
        quantity: item.quantity
      };
    }));

    const subParams: any = {
      customer: customerId,
      items: resolvedItems,
      default_payment_method: setupIntent.payment_method as string,
      metadata: {
        user_id: userId,
        action_type: trialDays ? 'new_subscription_after_trial_setup' : 'new_subscription',
        setup_intent_id: setupIntentId,
        ...metadata
      }
    };
    if (trialDays) subParams.trial_period_days = trialDays;
    if (hasAddress) subParams.automatic_tax = { enabled: true };

    // Idempotency key scoped to this SetupIntent — Stripe deduplicates
    // concurrent creates for the same customer triggered by the same payment flow.
    const subIdempotencyKey = `sub_create_${setupIntentId}`;
    const subscription = await stripe.subscriptions.create(subParams, {
      idempotencyKey: subIdempotencyKey
    });
    if (DEBUG_AI) console.log(`✅ Subscription created:`, {
      subscription_id: subscription.id,
      status: subscription.status,
      trial_end: subscription.trial_end
    });

    return subscription;
  }
}

export const stripeService = new StripeService();