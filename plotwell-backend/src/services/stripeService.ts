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
          console.log('Stored customer ID not found in Stripe, clearing and creating new customer');
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

  async createCheckoutSession(userId: string, priceId: string, metadata?: Record<string, string>, embedded?: boolean, currency?: string): Promise<Stripe.Checkout.Session> {
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
      const subscriptionStatus = await this.getSubscriptionStatus(userId);
      const hasActiveSubscription = subscriptionStatus.stripe_subscription_id &&
                                   subscriptionStatus.subscription_status === 'active';

      let sessionConfig: Stripe.Checkout.SessionCreateParams;

      // Base config for embedded or hosted checkout
      const baseConfig: Stripe.Checkout.SessionCreateParams = {
        locale: stripeLocale,
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'subscription',
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
    try {
      // Get Stripe IDs from users table
      const { data: user } = await supabase
        .from('users')
        .select('stripe_customer_id, stripe_subscription_id')
        .eq('id', userId)
        .single();

      // Get subscription data from user_subscriptions table
      // Don't filter by status - we need to see the actual DB state for sync purposes
      const { data: userSub } = await supabase
        .from('user_subscriptions')
        .select('plan_id, status, current_period_end, current_period_start, cancel_at_period_end')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!user?.stripe_customer_id) {
        return {
          plan_id: 'free',
          subscription_status: 'active',
          current_period_end: null,
          current_period_start: null,
          cancel_at_period_end: false,
          stripe_customer_id: null,
          stripe_subscription_id: null
        };
      }

      // Get active subscription from Stripe
      let stripeSubscriptionId = user.stripe_subscription_id;
      let currentPeriodEnd = userSub?.current_period_end || null;
      let currentPeriodStart = userSub?.current_period_start || null;
      let cancelAtPeriodEnd = userSub?.cancel_at_period_end || false;
      
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: 'active',
          limit: 10 // Get more subscriptions to detect duplicates
        });

        // Check for multiple active subscriptions (duplicates)
        if (subscriptions.data.length > 1) {
          console.error('Multiple active subscriptions detected for customer:', user.stripe_customer_id);

          // Use the newest subscription (most recently created)
          const newestSubscription = subscriptions.data.sort((a: any, b: any) => b.created - a.created)[0];

          const subscription = newestSubscription;
          stripeSubscriptionId = subscription.id;

          // Get the actual dates from Stripe if missing from database
          if (!currentPeriodEnd && (subscription as any).current_period_end) {
            currentPeriodEnd = new Date((subscription as any).current_period_end * 1000).toISOString();
          }
          if (!currentPeriodStart && (subscription as any).current_period_start) {
            currentPeriodStart = new Date((subscription as any).current_period_start * 1000).toISOString();
          }
          
          cancelAtPeriodEnd = subscription.cancel_at_period_end || false;
          
        } else if (subscriptions.data.length === 1) {
          const subscription = subscriptions.data[0];
          stripeSubscriptionId = subscription.id;

          // Get the actual dates from Stripe if missing from database
          if (!currentPeriodEnd && (subscription as any).current_period_end) {
            currentPeriodEnd = new Date((subscription as any).current_period_end * 1000).toISOString();
          }
          if (!currentPeriodStart && (subscription as any).current_period_start) {
            currentPeriodStart = new Date((subscription as any).current_period_start * 1000).toISOString();
          }

          cancelAtPeriodEnd = subscription.cancel_at_period_end || false;
        } else {
          // No active subscriptions in Stripe - clear the subscription ID
          // This handles the case where Stripe cancelled the subscription
          // (e.g., period ended) but webhook didn't fire to update our DB
          stripeSubscriptionId = null;
        }
      } catch (stripeError) {
        console.error('Error fetching Stripe subscriptions:', stripeError);
      }

      // CRITICAL FIX: Only return subscription data if there's an actual active Stripe subscription
      // If no active subscription in Stripe, user should be treated as free plan
      if (!stripeSubscriptionId) {
        // Sync DB: if DB still says paid but Stripe has no active subscription, fix it
        if (userSub && userSub.plan_id !== 'free') {
          console.log(`⚠️ Stripe has no active subscription for user ${userId} but DB says plan_id=${userSub.plan_id} - downgrading to free`);
          await supabase
            .from('user_subscriptions')
            .update({
              plan_id: 'free',
              status: 'cancelled',
              cancel_at_period_end: false,
              additional_projects: 0,
              additional_collaborators: 0,
              updated_at: new Date().toISOString()
            })
            .eq('user_id', userId);
        }
        return {
          plan_id: 'free',
          subscription_status: 'active',
          current_period_end: null,
          current_period_start: null,
          cancel_at_period_end: false,
          stripe_customer_id: user.stripe_customer_id,
          stripe_subscription_id: null
        };
      }

      // Get the actual plan from Stripe subscription instead of relying on database
      let detectedPlanId = userSub?.plan_id || 'free';
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: 'active',
          limit: 1
        });

        if (subscriptions.data.length > 0) {
          const subscription = subscriptions.data[0];

          // Search ALL subscription items for the base plan price
          // (items.data[0] may be an addon, not the base plan)
          const { getPlanIdFromStripePrice } = require('../config/pricingPlans');
          let foundPlanId: string | null = null;
          for (const item of subscription.items.data) {
            const itemPriceId = item.price?.id;
            if (itemPriceId) {
              const mapped = getPlanIdFromStripePrice(itemPriceId);
              if (mapped) {
                foundPlanId = mapped;
                break;
              }
            }
          }

          if (foundPlanId) {
            detectedPlanId = foundPlanId;

            // Update database if plan differs - now in user_subscriptions table
            if (detectedPlanId !== userSub?.plan_id) {

              await supabase
                .from('user_subscriptions')
                .upsert({
                  user_id: userId,
                  plan_id: detectedPlanId,
                  status: 'active',
                  updated_at: new Date().toISOString()
                }, {
                  onConflict: 'user_id'
                });
            }
          }
        }
      } catch (error) {
        console.error('Error detecting plan from Stripe subscription:', error);
        // Fall back to database plan if Stripe detection fails
      }

      return {
        plan_id: detectedPlanId,
        subscription_status: userSub?.status || 'active',
        current_period_end: currentPeriodEnd,
        current_period_start: currentPeriodStart,
        cancel_at_period_end: cancelAtPeriodEnd,
        stripe_customer_id: user.stripe_customer_id,
        stripe_subscription_id: stripeSubscriptionId
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
  async createInvoiceItem(customerId: string, amount: number, description: string, currency: string = 'eur'): Promise<Stripe.InvoiceItem> {
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
  async issueCreditInvoiceItem(customerId: string, creditAmount: number, description: string, currency: string = 'eur'): Promise<Stripe.InvoiceItem> {
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

      const actualRefundAmount = refund.amount / 100; // Convert back to euros

      return { refund, amount: actualRefundAmount };
    } catch (error) {
      console.error('❌ Error processing refund:', error);
      return { refund: null, amount: 0 };
    }
  }

  // EMERGENCY: Method to cancel duplicate subscriptions
  async cancelDuplicateSubscriptions(customerId: string): Promise<void> {
    try {
      // Get ALL subscriptions for this customer (not just active ones)
      const allSubscriptions = await stripe.subscriptions.list({
        customer: customerId,
        limit: 20, // Get more to see all subscriptions
      });

      // Filter only active subscriptions
      const activeSubscriptions = allSubscriptions.data.filter((sub: any) => sub.status === 'active');

      if (activeSubscriptions.length <= 1) {
        return;
      }

      // Sort by creation date (keep the newest one)
      activeSubscriptions.sort((a: any, b: any) => b.created - a.created);

      const subscriptionToKeep = activeSubscriptions[0];
      const subscriptionsToCancel = activeSubscriptions.slice(1);

      // Cancel each duplicate subscription
      for (const subscription of subscriptionsToCancel) {
        try {
          await stripe.subscriptions.cancel(subscription.id);
        } catch (cancelError) {
          console.error('Failed to cancel duplicate subscription:', subscription.id, cancelError);
        }
      }

    } catch (error) {
      console.error('Error in subscription cleanup:', error);
      throw error;
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
            console.log(`✅ Cancelled subscription: ${subscription.id}`);
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
        console.log(`✅ Deleted Stripe customer: ${customerId}`);
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
      // Get all recent checkout sessions for this customer
      const checkoutSessions = await stripe.checkout.sessions.list({
        customer: customerId,
        limit: 20
      });

      // Filter for open/incomplete sessions
      const incompleteSessionsToExpire = checkoutSessions.data.filter((session: any) =>
        session.status === 'open' && session.payment_status !== 'paid'
      );

      if (incompleteSessionsToExpire.length === 0) {
        return;
      }

      // Expire each incomplete session
      for (const session of incompleteSessionsToExpire) {
        try {
          await stripe.checkout.sessions.expire(session.id);
        } catch (expireError: any) {
          // If already expired or completed, that's fine - ignore silently
          if (expireError.code !== 'resource_missing' && expireError.code !== 'checkout_session_already_expired') {
            console.error('Failed to expire session:', session.id, expireError.message);
          }
        }
      }

    } catch (error) {
      console.error('Error cleaning up checkout sessions:', error);
      // Don't throw - this is a cleanup operation, not critical to fail the entire flow
    }
  }
}

export const stripeService = new StripeService();