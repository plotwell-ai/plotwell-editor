import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { PRICING_PLANS, PricingPlan, UsageStats, checkLimit, getRemainingLimit, getPlanById, AI_CREDITS_CONFIG, currentPriceIds, getEffectiveCost, EXPANSION_PRICING } from '../config/pricingPlans';
// Note: MonthlyBillingService has been removed - replaced with unified billing system
// Note: Image credits have been replaced with AI credits (one-time purchases)

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-08-27.basil',
});

export class PricingService {
  private supabase: any;
  // Note: monthlyBilling has been removed

  constructor(supabaseClient: any) {
    this.supabase = supabaseClient;
    // Note: monthlyBilling service removed
  }

  /**
   * Check if user has active paid plan.
   * Delegates to canonical helpers.
   */
  async hasPaidPlan(userId: string): Promise<boolean> {
    try {
      const { getSubscriptionRecord, isPaidSubscription } = require('../utils/subscriptionHelpers');
      const sub = await getSubscriptionRecord(this.supabase, userId);
      return isPaidSubscription(sub);
    } catch (error) {
      console.error('Error checking paid plan:', error);
      return false;
    }
  }

  /**
   * Get user's current subscription and usage directly from tables
   */
  async getUserSubscription(userId: string) {
    const { getSubscriptionRecord } = require('../utils/subscriptionHelpers');

    try {
      // Check if we need to sync with Stripe (only if past billing period end)
      await this.checkAndSyncStripeSubscription(userId);

      // Canonical subscription query
      const subscriptionData = await getSubscriptionRecord(this.supabase, userId);

      // Fetch quota data - ai_credits_balance is the unified credit balance (one-time purchases)
      const { data: quotaData } = await this.supabase
        .from('user_quotas')
        .select('ai_generations_used, ai_credits_balance, ai_credits_purchased_total, storage_used_gb')
        .eq('user_id', userId)
        .single();

      // Count all projects except archived (includes trashed projects in count)
      // This prevents users from using trash as a workaround to exceed limits
      const { data: projectsData } = await this.supabase
        .from('projects')
        .select('id, deleted')
        .eq('user_id', userId)
        .neq('status', 'archived');

      // Calculate breakdown
      const activeCount = projectsData?.filter(p => !p.deleted).length || 0;
      const trashedCount = projectsData?.filter(p => p.deleted).length || 0;

      // Count user's documents dynamically
      let documentCount = 0;
      if (projectsData && projectsData.length > 0) {
        const projectIds = projectsData.map(p => p.id);
        
        const { data: documentsData } = await this.supabase
          .from('project_documents')
          .select('id')
          .in('project_id', projectIds);
          
        documentCount = documentsData?.length || 0;
      }

      // Count PAID collaborators across all user's projects (only editors/admins, not viewers)
      // Viewers are FREE and UNLIMITED - they don't count toward limits
      let maxCollaborators = 1; // Always count the owner

      if (projectsData && projectsData.length > 0) {
        // For each project, count active collaborators with editor or admin roles (excluding viewers)
        const projectIds = projectsData.map(p => p.id);

        const { data: collaboratorsData } = await this.supabase
          .from('project_collaborators')
          .select('project_id, role')
          .in('project_id', projectIds)
          .eq('status', 'active')
          .in('role', ['editor', 'admin']); // ONLY count paid roles, NOT viewers


        if (collaboratorsData && collaboratorsData.length > 0) {
          // Group by project_id and find the project with most PAID collaborators
          const collaboratorsByProject = collaboratorsData.reduce((acc, collab) => {
            acc[collab.project_id] = (acc[collab.project_id] || 0) + 1;
            return acc;
          }, {} as Record<string, number>);


          // Find the maximum paid collaborators for any single project (+ 1 for owner)
          const collaboratorCounts = Object.values(collaboratorsByProject) as number[];
          const maxProjectCollaborators = collaboratorCounts.length > 0 ? Math.max(...collaboratorCounts) : 0;
          maxCollaborators = maxProjectCollaborators + 1; // +1 for the owner
        }
      }
      

      const planId = subscriptionData?.plan_id || 'free';
      const plan = getPlanById(planId);

      // Check if user ever had a paid subscription (not just a Stripe customer)
      // stripe_customer_id is created at checkout session time, before payment completes
      const { data: userStripeData } = await this.supabase
        .from('users')
        .select('stripe_customer_id, stripe_subscription_id')
        .eq('id', userId)
        .single();

      // Check if user_subscriptions record shows a past paid subscription
      let hadPreviousSubscription = false;
      if (subscriptionData?.status === 'cancelled') {
        hadPreviousSubscription = true;
      } else if (userStripeData?.stripe_customer_id) {
        // Check Stripe for any past subscriptions (covers edge cases)
        try {
          const allSubs = await stripe.subscriptions.list({
            customer: userStripeData.stripe_customer_id,
            limit: 1,
            status: 'all'
          });
          hadPreviousSubscription = allSubs.data.length > 0;
        } catch (err) {
          // If Stripe check fails, fall back to DB status
        }
      }

      // Detect billing cycle from Stripe subscription (applies to all users — free users can have addon subs)
      let billingCycle: 'monthly' | 'yearly' = 'monthly';
      try {
        if (userStripeData?.stripe_subscription_id) {
          const stripeSub = await stripe.subscriptions.retrieve(userStripeData.stripe_subscription_id, {
            expand: ['items.data.price']
          });
          const hasYearlyItem = stripeSub.items.data.some((item: any) =>
            item.price.recurring?.interval === 'year'
          );
          if (hasYearlyItem) billingCycle = 'yearly';
        }
      } catch (err) {
        console.error('⚠️ Error detecting billing cycle:', err);
      }

      // Build available addons — available to all users (expansion model)
      const ep = EXPANSION_PRICING;
      const addons = [
        {
          type: 'additional_projects',
          name: 'Additional Projects',
          description: 'Add more active projects',
          price_per_unit: billingCycle === 'yearly'
            ? ep.additionalProjects.yearlyPricePerProject
            : ep.additionalProjects.pricePerProject,
          price_per_unit_monthly: ep.additionalProjects.pricePerProject,
          price_per_unit_yearly: ep.additionalProjects.yearlyPricePerProject,
          currency: ep.additionalProjects.currency,
          max_additional: ep.additionalProjects.maxAdditional,
          current_quantity: subscriptionData?.additional_projects || 0
        },
        {
          type: 'additional_collaborators',
          name: 'Additional Collaborators',
          description: 'Add more team members to your projects',
          price_per_unit: billingCycle === 'yearly'
            ? ep.additionalCollaborators.yearlyPricePerCollaborator
            : ep.additionalCollaborators.pricePerCollaborator,
          price_per_unit_monthly: ep.additionalCollaborators.pricePerCollaborator,
          price_per_unit_yearly: ep.additionalCollaborators.yearlyPricePerCollaborator,
          currency: ep.additionalCollaborators.currency,
          max_additional: ep.additionalCollaborators.maxAdditional,
          current_quantity: subscriptionData?.additional_collaborators || 0
        }
      ];
      // Note: AI credits are one-time purchases via /api/ai-credits/purchase, not listed here

      // Ensure free users have their 5-credit pool initialized
      let aiCreditsBalance = quotaData?.ai_credits_balance || 0;
      if (planId === 'free' && aiCreditsBalance === 0) {
        aiCreditsBalance = await this.ensureFreeUserCredits(userId);
      }

      return {
        user_id: userId,
        plan_id: planId,
        subscription_status: subscriptionData?.status || 'active',
        ai_generations_used: quotaData?.ai_generations_used || 0,
        // AI credits — free users: 5 lifetime pool; paid users: purchased credits
        ai_credits_balance: aiCreditsBalance,
        ai_credits_purchased_total: quotaData?.ai_credits_purchased_total || 0,
        storage_used_gb: quotaData?.storage_used_gb || 0,
        projects_count: projectsData?.length || 0,
        projects_active_count: activeCount,
        projects_trashed_count: trashedCount,
        collaborators_count: maxCollaborators,
        documents_count: documentCount,
        additional_projects: subscriptionData?.additional_projects || 0,
        additional_collaborators: subscriptionData?.additional_collaborators || 0,
        stripe_subscription_id: subscriptionData?.stripe_subscription_id || null,
        billing_cycle: billingCycle,
        cancel_at_period_end: subscriptionData?.cancel_at_period_end || false,
        current_period_end: subscriptionData?.current_period_end || null,
        plan_price: subscriptionData?.plan_price || null,
        plan_currency: subscriptionData?.plan_currency || 'usd',
        available_addons: addons,
        had_previous_subscription: hadPreviousSubscription
      };
    } catch (error) {
      console.error('Error fetching user subscription:', error);
      // Return default free plan if error occurs
      return {
        user_id: userId,
        plan_id: 'free',
        subscription_status: 'active',
        ai_generations_used: 0,
        ai_credits_balance: 0,
        ai_credits_purchased_total: 0,
        storage_used_gb: 0,
        projects_count: 0,
        projects_active_count: 0,
        projects_trashed_count: 0,
        collaborators_count: 1,
        documents_count: 0,
        additional_projects: 0,
        additional_collaborators: 0,
        stripe_subscription_id: null,
        cancel_at_period_end: false,
        current_period_end: null,
        plan_price: null,
        plan_currency: 'usd',
        available_addons: []
      };
    }
  }

  /**
   * Get pricing plan details
   */
  getPlan(planId: string): PricingPlan | null {
    return PRICING_PLANS[planId] || null;
  }

  /**
   * Get effective limits including addons
   * Note: AI credits are no longer part of subscription limits - they are one-time purchases
   */
  getEffectiveLimits(plan: PricingPlan, additionalProjects: number = 0, additionalCollaborators: number = 0) {
    return {
      projects: plan.limits.projects === -1 ? -1 : plan.limits.projects + additionalProjects,
      collaborators: plan.limits.collaborators + additionalCollaborators,
      documents: plan.limits.documents,
      storyboardPanels: plan.limits.storyboardPanels,
      characters: plan.limits.characters,
      locations: plan.limits.locations,
      scriptVersions: plan.limits.scriptVersions,
      // AI credits are tracked separately in user_quotas.ai_credits_balance
    };
  }

  /**
   * Check if user can perform an action based on their plan limits (including addons)
   */
  async canPerformAction(userId: string, action: 'create_project' | 'ai_generation' | 'add_collaborator'): Promise<{ allowed: boolean; reason?: string; remaining?: number }> {
    const subscription = await this.getUserSubscription(userId);
    const plan = this.getPlan(subscription.plan_id);

    if (!plan) {
      return { allowed: false, reason: 'Invalid subscription plan' };
    }

    // Get effective limits including addons
    // Note: AI credits are no longer part of subscription limits
    const effectiveLimits = this.getEffectiveLimits(
      plan,
      subscription.additional_projects || 0,
      subscription.additional_collaborators || 0
    );

    // Users keep full paid plan limits until the billing period ends,
    // even if cancel_at_period_end is true

    const usage: UsageStats = {
      projectCount: subscription.projects_count || 0,
      aiCreativeTasksThisMonth: subscription.ai_generations_used || 0,
      // Note: AI credits are tracked separately via getAICreditsBalance()
      collaboratorCount: subscription.collaborators_count || 0,
      documentCount: subscription.documents_count || 0
    };

    switch (action) {
      case 'create_project':
        
        try {
          // Note: monthlyBilling service removed - using basic limit check based on effective limits
          const projectLimit = effectiveLimits.projects;
          const canCreateProject = projectLimit === -1 || usage.projectCount < projectLimit;
          const remainingProjects = projectLimit === -1 ? -1 : Math.max(0, projectLimit - usage.projectCount);

          const monthlyResult = {
            allowed: canCreateProject,
            reason: canCreateProject ? undefined : 'Project limit reached'
          };
          
          return {
            allowed: monthlyResult.allowed,
            reason: monthlyResult.reason,
            remaining: remainingProjects
          };
        } catch (error) {
          console.error('🔍 PROJECT CREATION DEBUG - Error with basic limit check, falling back:', error);

          const projectLimit = effectiveLimits.projects;
          const canCreateProject = projectLimit === -1 || usage.projectCount < projectLimit;
          const projectsRemaining = projectLimit === -1 ? -1 : Math.max(0, projectLimit - usage.projectCount);

          return {
            allowed: canCreateProject,
            reason: canCreateProject ? undefined : `You've reached your project limit of ${projectLimit}. Add more projects from $3/month.`,
            remaining: projectsRemaining
          };
        }

      case 'ai_generation': {
        // All users use the unified credit system — seed trial credits for new users first
        const balance = await this.ensureFreeUserCredits(userId);
        const cost = getEffectiveCost('creative');
        const canGenerate = cost === 0 || balance >= cost;
        return {
          allowed: canGenerate,
          reason: canGenerate ? undefined : `AI tasks require ${cost} credit(s). Your balance: ${balance}. Purchase more credits to continue.`,
          remaining: Math.floor(balance / Math.max(cost, 1))
        };
      }

      case 'add_collaborator':
        const collaboratorLimit = effectiveLimits.collaborators;
        const canAddCollaborator = usage.collaboratorCount < collaboratorLimit;
        const collaboratorsRemaining = Math.max(0, collaboratorLimit - usage.collaboratorCount);
        return {
          allowed: canAddCollaborator,
          reason: canAddCollaborator ? undefined : `You've reached your collaborator limit of ${collaboratorLimit}. Add more collaborators from $3/month.`,
          remaining: collaboratorsRemaining
        };

      default:
        return { allowed: true };
    }
  }

  /**
   * Track usage for AI generation (simplified - no database function dependency)
   */
  async trackAIGeneration(userId: string): Promise<void> {
    // Manual update/insert only (removed dependency on database function)
      
      // Get current usage and increment it
      const { data: currentData } = await this.supabase
        .from('user_quotas')
        .select('ai_generations_used')
        .eq('user_id', userId)
        .single();

      if (currentData) {
        // Increment existing record
        const { error: updateError } = await this.supabase
          .from('user_quotas')
          .update({ 
            ai_generations_used: (currentData.ai_generations_used || 0) + 1,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId);

        if (updateError) {
          console.error('Error updating AI usage:', updateError);
        }
      } else {
        // No record exists, insert a new one
        const { error: insertError } = await this.supabase
          .from('user_quotas')
          .upsert({
            user_id: userId,
            ai_generations_used: 1,
            storage_used_gb: 0,
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id' });

        if (insertError) {
          console.error('Error inserting AI usage record:', insertError);
        }
      }
  }

  // ============================================================================
  // AI CREDITS METHODS (One-time purchases, never expire)
  // ============================================================================

  /**
   * Get user's current AI credits balance
   */
  async getAICreditsBalance(userId: string): Promise<number> {
    const { data } = await this.supabase
      .from('user_quotas')
      .select('ai_credits_balance')
      .eq('user_id', userId)
      .single();
    return data?.ai_credits_balance || 0;
  }

  /**
   * Ensure free users have their AI credits initialized.
   * Free users get 10 trial credits on first use (aiTrialCredits in pricingPlans.ts).
   * This is a one-time lazy initialization — once credits are set, subsequent calls are no-ops.
   * Returns the current balance after ensuring initialization.
   */
  async ensureFreeUserCredits(userId: string): Promise<number> {
    const FREE_AI_LIMIT = PRICING_PLANS.free.limits.aiTrialCredits; // 10

    const { data: quota } = await this.supabase
      .from('user_quotas')
      .select('ai_credits_balance, ai_generations_used')
      .eq('user_id', userId)
      .single();

    const currentBalance = quota?.ai_credits_balance || 0;
    const alreadyUsed = quota?.ai_generations_used || 0;

    // If the user already has credits OR has a usage history, don't override.
    // A balance of 0 with usage > 0 means they've legitimately spent their credits.
    if (currentBalance > 0 || alreadyUsed > 0) return currentBalance;

    // Truly new user — grant the initial free credit pool
    const initialCredits = Math.max(0, FREE_AI_LIMIT - alreadyUsed);

    if (initialCredits > 0) {
      // Use upsert so it works whether or not the user_quotas row exists yet
      const { error } = await this.supabase
        .from('user_quotas')
        .upsert(
          { user_id: userId, ai_credits_balance: initialCredits },
          { onConflict: 'user_id', ignoreDuplicates: false }
        );
      if (error) {
        console.error(`❌ Free user ${userId}: failed to initialize AI credits:`, error);
      } else {
        if (DEBUG_AI) console.log(`✅ Free user ${userId}: initialized ${initialCredits} AI credits (${alreadyUsed} tasks already used)`);
      }
    }

    return initialCredits;
  }

  /**
   * Consume AI credits for an operation (e.g., image generation)
   * Returns true if successful, false if insufficient credits
   */
  async consumeAICredits(userId: string, amount: number, description: string, metadata?: Record<string, unknown>): Promise<boolean> {
    // Read current balance
    const { data: quota } = await this.supabase
      .from('user_quotas')
      .select('ai_credits_balance')
      .eq('user_id', userId)
      .single();

    const currentBalance = quota?.ai_credits_balance || 0;
    if (currentBalance < amount) {
      console.error(`❌ Insufficient AI credits for user ${userId}. Required: ${amount}, Available: ${currentBalance}`);
      return false;
    }

    const newBalance = currentBalance - amount;

    // Optimistic lock: only update if balance hasn't changed since we read it.
    // If another concurrent request consumed credits between our read and write,
    // this update will match 0 rows and we retry.
    const { data: updated, error: updateError } = await this.supabase
      .from('user_quotas')
      .update({
        ai_credits_balance: newBalance,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('ai_credits_balance', currentBalance) // Only update if balance unchanged
      .select('ai_credits_balance')
      .single();

    if (updateError || !updated) {
      // Conflict: balance changed between read and write (concurrent request).
      // Retry once with fresh balance.
      const { data: freshQuota } = await this.supabase
        .from('user_quotas')
        .select('ai_credits_balance')
        .eq('user_id', userId)
        .single();

      const freshBalance = freshQuota?.ai_credits_balance || 0;
      if (freshBalance < amount) {
        console.error(`❌ Insufficient AI credits for user ${userId} (after retry). Required: ${amount}, Available: ${freshBalance}`);
        return false;
      }

      const retryNewBalance = freshBalance - amount;
      const { data: retryUpdated, error: retryError } = await this.supabase
        .from('user_quotas')
        .update({
          ai_credits_balance: retryNewBalance,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('ai_credits_balance', freshBalance)
        .select('ai_credits_balance')
        .single();

      if (retryError || !retryUpdated) {
        console.error(`❌ Failed to consume AI credits for user ${userId} after retry (concurrent conflict)`);
        return false;
      }

      // Log transaction with retry balance
      await this.supabase
        .from('ai_credit_transactions')
        .insert({
          user_id: userId,
          transaction_type: 'usage',
          amount: -amount,
          balance_after: retryNewBalance,
          description,
          metadata: metadata || {}
        });

      if (DEBUG_AI) console.log(`🎨 AI credits consumed for user ${userId}: -${amount}. New balance: ${retryNewBalance} (after retry)`);
      return true;
    }

    // Log transaction
    await this.supabase
      .from('ai_credit_transactions')
      .insert({
        user_id: userId,
        transaction_type: 'usage',
        amount: -amount,
        balance_after: newBalance,
        description,
        metadata: metadata || {}
      });

    if (DEBUG_AI) console.log(`🎨 AI credits consumed for user ${userId}: -${amount}. New balance: ${newBalance}`);
    return true;
  }

  /**
   * Add AI credits to user's balance (from purchase)
   */
  async addAICredits(userId: string, amount: number, description: string, metadata?: Record<string, unknown>): Promise<void> {
    // Ensure quota record exists
    await this.supabase
      .from('user_quotas')
      .upsert({
        user_id: userId,
        ai_credits_balance: 0,
        ai_credits_purchased_total: 0
      }, { onConflict: 'user_id', ignoreDuplicates: true });

    // Get current balance and update
    const { data: quota } = await this.supabase
      .from('user_quotas')
      .select('ai_credits_balance, ai_credits_purchased_total')
      .eq('user_id', userId)
      .single();

    const currentBalance = quota?.ai_credits_balance || 0;
    const currentTotal = quota?.ai_credits_purchased_total || 0;
    const newBalance = currentBalance + amount;

    const { error: updateError } = await this.supabase
      .from('user_quotas')
      .update({
        ai_credits_balance: newBalance,
        ai_credits_purchased_total: currentTotal + amount,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (updateError) {
      console.error('Error adding AI credits:', updateError);
      throw updateError;
    }

    // Log transaction
    await this.supabase
      .from('ai_credit_transactions')
      .insert({
        user_id: userId,
        transaction_type: 'purchase',
        amount: amount,
        balance_after: newBalance,
        description,
        metadata: metadata || {}
      });

    if (DEBUG_AI) console.log(`💰 AI credits added for user ${userId}: +${amount}. New balance: ${newBalance}`);
  }

  /**
   * Get AI credit transaction history
   */
  async getAICreditTransactions(userId: string, limit: number = 50): Promise<any[]> {
    const { data } = await this.supabase
      .from('ai_credit_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    return data || [];
  }

  /**
   * Upgrade user subscription
   */
  async upgradeSubscription(userId: string, newPlanId: string, stripeSubscriptionId?: string): Promise<void> {
    // Get current subscription before upgrade/downgrade
    const currentSubscription = await this.getUserSubscription(userId);
    const currentPlan = PRICING_PLANS[currentSubscription.plan_id];
    const newPlan = PRICING_PLANS[newPlanId];

    if (!currentPlan || !newPlan) {
      throw new Error('Invalid plan configuration');
    }

    // Calculate add-on adjustments (works for both upgrades and downgrades)
    const addonAdjustments = this.calculateUpgradeDowngradeAdjustments(currentPlan, newPlan, currentSubscription);

    const { error } = await this.supabase
      .from('user_subscriptions')
      .upsert({
        user_id: userId,
        plan_id: newPlanId,
        stripe_subscription_id: stripeSubscriptionId,
        status: 'active',
        additional_projects: addonAdjustments.newAdditionalProjects,
        additional_collaborators: addonAdjustments.newAdditionalCollaborators,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      });

    if (error) {
      console.error('Error upgrading subscription:', error);
      throw error;
    }

    // Log billing event with credit information
    await this.logBillingEvent(userId, 'plan_upgraded', {
      old_plan: currentSubscription.plan_id,
      new_plan: newPlanId,
      stripe_subscription_id: stripeSubscriptionId,
      addon_adjustments: addonAdjustments,
      credits_applied: addonAdjustments.totalCreditsDollars > 0
    });

    // If there are credits to apply, create a credit transaction
    if (addonAdjustments.totalCreditsDollars > 0) {
      await this.createCreditTransaction(userId, addonAdjustments);
    }
  }

  /**
   * Calculate how add-ons should be adjusted when upgrading or downgrading plans
   */
  public calculateUpgradeDowngradeAdjustments(currentPlan: any, newPlan: any, currentSubscription: any) {
    const currentAdditionalProjects = currentSubscription.additional_projects || 0;
    const currentAdditionalCollaborators = currentSubscription.additional_collaborators || 0;

    let newAdditionalProjects = currentAdditionalProjects;
    let newAdditionalCollaborators = currentAdditionalCollaborators;
    let projectCreditsDollars = 0;
    let collaboratorCreditsDollars = 0;

    const currentUsage = {
      projects: currentSubscription.projects_count || 0,
      collaborators: currentSubscription.collaborators_count || 0
    };

    // Handle projects adjustment (upgrade or downgrade)
    if (newPlan.limits.projects !== -1) {
      // Calculate required additional projects to maintain current usage
      const requiredAdditionalProjects = Math.max(0, currentUsage.projects - newPlan.limits.projects);
      
      if (newPlan.addons?.additionalProjects?.enabled && requiredAdditionalProjects > 0) {
        // Downgrade case: need to purchase add-ons to maintain current usage
        newAdditionalProjects = requiredAdditionalProjects;
      } else if (requiredAdditionalProjects === 0) {
        // Upgrade case or usage fits in base plan: may get credits
        if (currentAdditionalProjects > 0) {
          const currentEffectiveLimit = currentPlan.limits.projects + currentAdditionalProjects;
          const newBaseLimit = newPlan.limits.projects;

          if (newBaseLimit >= currentEffectiveLimit) {
            // New plan covers all current projects, credit back all additional projects
            projectCreditsDollars = currentAdditionalProjects * (currentPlan.addons?.additionalProjects?.pricePerProject || 5);
            newAdditionalProjects = 0;
          } else if (newBaseLimit > currentPlan.limits.projects) {
            // New plan covers some additional projects, credit back the covered ones
            const coveredAdditionalProjects = newBaseLimit - currentPlan.limits.projects;
            const remainingAdditionalProjects = currentAdditionalProjects - coveredAdditionalProjects;
            
            projectCreditsDollars = coveredAdditionalProjects * (currentPlan.addons?.additionalProjects?.pricePerProject || 5);
            newAdditionalProjects = Math.max(0, remainingAdditionalProjects);
          }
        }
      }
    } else {
      // New plan has unlimited projects, credit back all additional projects
      if (currentAdditionalProjects > 0) {
        projectCreditsDollars = currentAdditionalProjects * (currentPlan.addons?.additionalProjects?.pricePerProject || 5);
        newAdditionalProjects = 0;
      }
    }

    // Handle collaborators adjustment (upgrade or downgrade)
    if (newPlan.limits.collaborators !== -1) {
      // Calculate required additional collaborators to maintain current usage
      const requiredAdditionalCollaborators = Math.max(0, currentUsage.collaborators - newPlan.limits.collaborators);
      
      if (newPlan.addons?.additionalCollaborators?.enabled && requiredAdditionalCollaborators > 0) {
        // Downgrade case: need to purchase add-ons to maintain current usage
        newAdditionalCollaborators = requiredAdditionalCollaborators;
      } else if (requiredAdditionalCollaborators === 0) {
        // Upgrade case or usage fits in base plan: may get credits
        if (currentAdditionalCollaborators > 0) {
          const currentEffectiveLimit = currentPlan.limits.collaborators + currentAdditionalCollaborators;
          const newBaseLimit = newPlan.limits.collaborators;

          if (newBaseLimit >= currentEffectiveLimit) {
            // New plan covers all current collaborators, credit back all additional collaborators
            collaboratorCreditsDollars = currentAdditionalCollaborators * (currentPlan.addons?.additionalCollaborators?.pricePerCollaborator || 10);
            newAdditionalCollaborators = 0;
          } else if (newBaseLimit > currentPlan.limits.collaborators) {
            // New plan covers some additional collaborators, credit back the covered ones
            const coveredAdditionalCollaborators = newBaseLimit - currentPlan.limits.collaborators;
            const remainingAdditionalCollaborators = currentAdditionalCollaborators - coveredAdditionalCollaborators;
            
            collaboratorCreditsDollars = coveredAdditionalCollaborators * (currentPlan.addons?.additionalCollaborators?.pricePerCollaborator || 10);
            newAdditionalCollaborators = Math.max(0, remainingAdditionalCollaborators);
          }
        }
      }
    } else {
      // New plan has unlimited collaborators, credit back all additional collaborators
      if (currentAdditionalCollaborators > 0) {
        collaboratorCreditsDollars = currentAdditionalCollaborators * (currentPlan.addons?.additionalCollaborators?.pricePerCollaborator || 10);
        newAdditionalCollaborators = 0;
      }
    }

    return {
      newAdditionalProjects,
      newAdditionalCollaborators,
      projectCreditsDollars,
      collaboratorCreditsDollars,
      totalCreditsDollars: projectCreditsDollars + collaboratorCreditsDollars,
      details: {
        projects: {
          before: currentAdditionalProjects,
          after: newAdditionalProjects,
          creditDollars: projectCreditsDollars
        },
        collaborators: {
          before: currentAdditionalCollaborators,
          after: newAdditionalCollaborators,
          creditDollars: collaboratorCreditsDollars
        }
      }
    };
  }

  /**
   * Create a credit transaction for unused add-ons
   */
  private async createCreditTransaction(userId: string, addonAdjustments: any) {
    const { error } = await this.supabase
      .from('addon_transactions')
      .insert({
        user_id: userId,
        addon_type: 'upgrade_credit',
        quantity: -1, // Negative quantity indicates credit
        unit_price_cents: Math.round(addonAdjustments.totalCreditsDollars * 100),
        total_price_cents: Math.round(addonAdjustments.totalCreditsDollars * 100),
        currency: 'USD',
        status: 'completed',
        metadata: {
          reason: 'Plan upgrade add-on credit',
          project_credits: addonAdjustments.projectCreditsDollars,
          collaborator_credits: addonAdjustments.collaboratorCreditsDollars,
          details: addonAdjustments.details
        }
      });

    if (error) {
      console.error('Error creating credit transaction:', error);
      // Don't throw - the upgrade should still succeed even if credit logging fails
    }
  }

  /**
   * Cancel user subscription
   */
  async cancelSubscription(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('user_subscriptions')
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (error) {
      console.error('Error canceling subscription:', error);
      throw error;
    }

    await this.logBillingEvent(userId, 'subscription_canceled');
  }

  /**
   * Log billing event for audit trail
   */
  async logBillingEvent(userId: string, eventType: string, metadata: any = {}): Promise<void> {
    const { error } = await this.supabase
      .from('billing_events')
      .insert({
        user_id: userId,
        event_type: eventType,
        metadata
      });

    if (error) {
      console.error('Error logging billing event:', error);
    }
  }

  /**
   * Get usage analytics for user
   */
  async getUsageAnalytics(userId: string): Promise<any> {
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    const [currentUsage, historicalUsage, monthlyBreakdown] = await Promise.all([
      this.getUserSubscription(userId),
      this.supabase
        .from('user_usage')
        .select('*')
        .eq('user_id', userId)
        .order('year', { ascending: false })
        .order('month', { ascending: false })
        .limit(12),
      // Get detailed breakdown from monthly_ai_usage_summary
      this.supabase
        .from('monthly_ai_usage_summary')
        .select('chat_completions_count, image_generations_count, script_generations, concept_generations, character_generations, storyboard_generations, location_generations')
        .eq('user_id', userId)
        .eq('month', currentMonth)
        .eq('year', currentYear)
        .maybeSingle()
    ]);

    const plan = this.getPlan(currentUsage.plan_id);

    // Calculate breakdown totals
    const breakdown = monthlyBreakdown.data || {};

    if (DEBUG_AI) console.log(`📊 Usage breakdown for user ${userId} (${currentMonth}/${currentYear}):`, {
      monthlyBreakdownData: monthlyBreakdown.data,
      monthlyBreakdownError: monthlyBreakdown.error,
      image_generations_count: breakdown.image_generations_count
    });

    const creativeTasksCount = (breakdown.chat_completions_count || 0) +
      (breakdown.script_generations || 0) +
      (breakdown.concept_generations || 0) +
      (breakdown.character_generations || 0) +
      (breakdown.storyboard_generations || 0) +
      (breakdown.location_generations || 0);
    const imageGenerationsCount = breakdown.image_generations_count || 0;

    // Get effective limits including addons
    const effectiveLimits = plan ? this.getEffectiveLimits(
      plan,
      currentUsage.additional_projects || 0,
      currentUsage.additional_collaborators || 0
    ) : null;

    return {
      current: {
        plan: plan,
        usage: {
          projects: currentUsage.projects_count,
          // aiCreativeTasks now reflects credits consumed (unified system)
          // For free users: tasks used = FREE_LIMIT - credits_remaining
          // For paid users: this field is legacy; use ai_credits_balance for remaining
          aiCreativeTasks: currentUsage.plan_id === 'free'
            ? Math.max(0, PRICING_PLANS.free.limits.aiCreativeTasks - (currentUsage.ai_credits_balance || 0))
            : (currentUsage.ai_generations_used || 0),
          aiCreditsBalance: currentUsage.ai_credits_balance || 0,
          collaborators: currentUsage.collaborators_count
        },
        limits: effectiveLimits || plan?.limits,
        addons: {
          additional_projects: currentUsage.additional_projects || 0,
          additional_collaborators: currentUsage.additional_collaborators || 0
        },
        // AI credits balance at top level (for frontend compatibility)
        ai_credits_balance: currentUsage.ai_credits_balance || 0,
        // AI credits info
        ai_credits: {
          balance: currentUsage.ai_credits_balance || 0,
          total_purchased: currentUsage.ai_credits_purchased_total || 0,
          cost_per_image: AI_CREDITS_CONFIG.costs.image,
          cost_per_video: AI_CREDITS_CONFIG.costs.video
        },
        // Breakdown of AI usage by type
        breakdown: {
          creativeTasks: creativeTasksCount,
          imageGenerations: imageGenerationsCount,
          details: {
            chat_completions: breakdown.chat_completions_count || 0,
            script_generations: breakdown.script_generations || 0,
            concept_generations: breakdown.concept_generations || 0,
            character_generations: breakdown.character_generations || 0,
            storyboard_generations: breakdown.storyboard_generations || 0,
            location_generations: breakdown.location_generations || 0,
            image_generations: breakdown.image_generations_count || 0
          }
        },
        remaining: {
          projects: plan ? getRemainingLimit(plan, {
            projectCount: currentUsage.projects_count,
            aiCreativeTasksThisMonth: currentUsage.ai_generations_used,
            collaboratorCount: currentUsage.collaborators_count,
            documentCount: currentUsage.documents_count || 0
          }, 'projects') : 0,
          aiCreativeTasks: plan ? getRemainingLimit(plan, {
            projectCount: currentUsage.projects_count,
            aiCreativeTasksThisMonth: currentUsage.ai_generations_used,
            collaboratorCount: currentUsage.collaborators_count,
            documentCount: currentUsage.documents_count || 0
          }, 'aiCreativeTasks') : 0,
          // Backward compatibility alias
          aiGenerations: plan ? getRemainingLimit(plan, {
            projectCount: currentUsage.projects_count,
            aiCreativeTasksThisMonth: currentUsage.ai_generations_used,
            collaboratorCount: currentUsage.collaborators_count,
            documentCount: currentUsage.documents_count || 0
          }, 'aiCreativeTasks') : 0
        }
      },
      historical: historicalUsage.data || []
    };
  }

  /**
   * Check if we need to sync with Stripe and reset AI generations counter
   * This is called automatically when fetching subscription data
   * Only calls Stripe if current_period_end is in the past
   */
  async checkAndSyncStripeSubscription(userId: string): Promise<void> {
    try {
      // Get current subscription data
      const { data: subscription } = await this.supabase
        .from('user_subscriptions')
        .select('stripe_subscription_id, current_period_start, current_period_end, status, last_stripe_sync, cancel_at_period_end, plan_id')
        .eq('user_id', userId)
        .single();

      if (!subscription) {
        return; // No subscription record
      }

      // Skip if already on free plan
      if (subscription.plan_id === 'free' && subscription.status === 'cancelled') {
        return;
      }

      const now = new Date();
      const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end) : null;

      // Fast local downgrade: if cancel_at_period_end is true and period has expired,
      // downgrade immediately without waiting for Stripe webhook or API call
      if (subscription.cancel_at_period_end && periodEnd && now > periodEnd) {
        if (DEBUG_AI) console.log(`⚠️ Subscription expired for user ${userId} (cancel_at_period_end=true, period ended ${periodEnd.toISOString()}) - downgrading to free`);
        await this.supabase
          .from('user_subscriptions')
          .update({
            plan_id: 'free',
            status: 'cancelled',
            cancel_at_period_end: false,
            stripe_subscription_id: null,
            additional_projects: 0,
            additional_collaborators: 0,
            last_stripe_sync: now.toISOString(),
            updated_at: now.toISOString()
          })
          .eq('user_id', userId);
        return;
      }

      if (!subscription.stripe_subscription_id) {
        return; // No Stripe subscription to sync
      }

      // Skip if already marked as cancelled/past_due and no stripe_subscription_id
      if (['cancelled', 'past_due', 'unpaid'].includes(subscription.status) && !subscription.stripe_subscription_id) {
        return;
      }

      // Still within current period, no need to sync
      if (periodEnd && now <= periodEnd) {
        return;
      }

      // Cooldown: don't re-sync more than once every 30 minutes
      if (subscription.last_stripe_sync) {
        const lastSync = new Date(subscription.last_stripe_sync);
        const minutesSinceSync = (now.getTime() - lastSync.getTime()) / (1000 * 60);
        if (minutesSinceSync < 30) {
          return; // Already synced recently
        }
      }

      // Call Stripe to get current subscription status
      const Stripe = require('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      let stripeSubscription;
      try {
        stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
      } catch (stripeError: any) {
        // Subscription not found in Stripe — clear it so we don't retry
        const code = stripeError?.code || stripeError?.raw?.code;
        const statusCode = stripeError?.statusCode || stripeError?.raw?.statusCode;
        if (code === 'resource_missing' || statusCode === 404) {
          console.warn(`⚠️ Stripe subscription ${subscription.stripe_subscription_id} not found - marking as cancelled`);
          const { error: updateError } = await this.supabase
            .from('user_subscriptions')
            .update({
              status: 'cancelled',
              plan_id: 'free',
              stripe_subscription_id: null,
              last_stripe_sync: now.toISOString(),
              updated_at: now.toISOString()
            })
            .eq('user_id', userId);
          if (updateError) {
            console.error('❌ Failed to clear invalid Stripe subscription:', updateError);
          }
          return;
        }
        throw stripeError;
      }

      const stripeStatus = stripeSubscription.status;

      // Handle non-active statuses (failed payment, canceled, etc.)
      if (['canceled', 'unpaid', 'incomplete_expired'].includes(stripeStatus)) {
        if (DEBUG_AI) console.log(`⚠️ Subscription ${subscription.stripe_subscription_id} is ${stripeStatus} - downgrading to free`);
        await this.supabase
          .from('user_subscriptions')
          .update({
            status: 'cancelled',
            plan_id: 'free',
            last_stripe_sync: now.toISOString(),
            updated_at: now.toISOString()
          })
          .eq('user_id', userId);
        return;
      }

      // Handle past_due (payment failed but subscription still exists)
      if (stripeStatus === 'past_due') {
        if (DEBUG_AI) console.log(`⚠️ Subscription ${subscription.stripe_subscription_id} is past_due - payment failed`);
        await this.supabase
          .from('user_subscriptions')
          .update({
            status: 'past_due',
            last_stripe_sync: now.toISOString(),
            updated_at: now.toISOString()
          })
          .eq('user_id', userId);
        return;
      }

      // Only proceed with renewal logic if subscription is active
      if (stripeStatus !== 'active') {
        if (DEBUG_AI) console.log(`⚠️ Subscription ${subscription.stripe_subscription_id} has status ${stripeStatus} - updating`);
        await this.supabase
          .from('user_subscriptions')
          .update({
            status: stripeStatus,
            last_stripe_sync: now.toISOString(),
            updated_at: now.toISOString()
          })
          .eq('user_id', userId);
        return;
      }

      // Subscription is active - handle successful renewal
      // Try to get period dates from subscription
      let stripePeriodStart = stripeSubscription.current_period_start;
      let stripePeriodEnd = stripeSubscription.current_period_end;

      if (DEBUG_AI) console.log(`🔍 Stripe sub period: start=${stripePeriodStart}, end=${stripePeriodEnd}, status=${stripeStatus}, items=${stripeSubscription.items?.data?.length || 0}`);

      // Fallback 1: subscription items have current_period_start/end
      if (!stripePeriodStart || !stripePeriodEnd) {
        const subItem = stripeSubscription.items?.data?.[0];
        if (subItem?.current_period_start && subItem?.current_period_end) {
          stripePeriodStart = subItem.current_period_start;
          stripePeriodEnd = subItem.current_period_end;
          if (DEBUG_AI) console.log(`✅ Got period dates from subscription item: ${new Date(stripePeriodStart * 1000).toISOString()} - ${new Date(stripePeriodEnd * 1000).toISOString()}`);
        }
      }

      // Fallback 2: subscription schedule
      if ((!stripePeriodStart || !stripePeriodEnd) && stripeSubscription.schedule) {
        if (DEBUG_AI) console.log(`🔍 Fetching schedule ${stripeSubscription.schedule} for period dates`);
        try {
          const schedule = await stripe.subscriptionSchedules.retrieve(stripeSubscription.schedule);
          const currentPhase = schedule.current_phase;
          if (currentPhase) {
            stripePeriodStart = currentPhase.start_date;
            stripePeriodEnd = currentPhase.end_date;
            if (DEBUG_AI) console.log(`✅ Got period dates from schedule: ${new Date(stripePeriodStart * 1000).toISOString()} - ${new Date(stripePeriodEnd * 1000).toISOString()}`);
          }
        } catch (scheduleError) {
          if (DEBUG_AI) console.log(`⚠️ Could not fetch schedule: ${scheduleError}`);
        }
      }

      // Fallback 3: latest paid invoice line items
      if (!stripePeriodStart || !stripePeriodEnd) {
        if (DEBUG_AI) console.log(`🔍 Fetching latest invoice for period dates`);
        try {
          const invoices = await stripe.invoices.list({
            subscription: subscription.stripe_subscription_id,
            status: 'paid',
            limit: 1,
          });
          const latestInvoice = invoices.data[0];
          if (latestInvoice?.lines?.data?.length) {
            // Find the line item with the latest period end
            let bestPeriod: { start: number; end: number } | null = null;
            for (const line of latestInvoice.lines.data) {
              if (line.period?.start && line.period?.end) {
                if (!bestPeriod || line.period.end > bestPeriod.end) {
                  bestPeriod = { start: line.period.start, end: line.period.end };
                }
              }
            }
            if (bestPeriod) {
              stripePeriodStart = bestPeriod.start;
              stripePeriodEnd = bestPeriod.end;
              if (DEBUG_AI) console.log(`✅ Got period dates from invoice line item: ${new Date(stripePeriodStart * 1000).toISOString()} - ${new Date(stripePeriodEnd * 1000).toISOString()}`);
            }
          }
        } catch (invoiceError) {
          if (DEBUG_AI) console.log(`⚠️ Could not fetch invoices: ${invoiceError}`);
        }
      }

      // If still no period dates, just update sync time
      if (!stripePeriodStart || !stripePeriodEnd) {
        if (DEBUG_AI) console.log(`⚠️ Subscription ${subscription.stripe_subscription_id} missing period dates - updating sync time only`);
        await this.supabase
          .from('user_subscriptions')
          .update({
            status: 'active',
            last_stripe_sync: now.toISOString(),
            updated_at: now.toISOString()
          })
          .eq('user_id', userId);
        return;
      }

      const newPeriodStart = new Date(stripePeriodStart * 1000);
      const newPeriodEnd = new Date(stripePeriodEnd * 1000);

      // Validate the dates are valid
      if (isNaN(newPeriodStart.getTime()) || isNaN(newPeriodEnd.getTime())) {
        if (DEBUG_AI) console.log(`⚠️ Subscription ${subscription.stripe_subscription_id} has invalid period dates - updating sync time only`);
        await this.supabase
          .from('user_subscriptions')
          .update({
            status: 'active',
            last_stripe_sync: now.toISOString(),
            updated_at: now.toISOString()
          })
          .eq('user_id', userId);
        return;
      }

      const oldPeriodStart = subscription.current_period_start ? new Date(subscription.current_period_start) : null;

      // Check if this is a new billing period
      const isNewPeriod = !oldPeriodStart || newPeriodStart.getTime() !== oldPeriodStart.getTime();

      // Update subscription with new period dates
      await this.supabase
        .from('user_subscriptions')
        .update({
          status: 'active',
          current_period_start: newPeriodStart.toISOString(),
          current_period_end: newPeriodEnd.toISOString(),
          last_stripe_sync: now.toISOString(),
          updated_at: now.toISOString()
        })
        .eq('user_id', userId);

      // NEW SYSTEM (January 2025):
      // - ai_generations_used is now a LIFETIME counter for FREE users only (never resets)
      // - PAID users use the credit system (ai_credits_balance) which is one-time purchases
      // - No need to reset ai_generations_used on subscription renewal anymore
      if (isNewPeriod) {
        if (DEBUG_AI) console.log(`✅ New billing period for user ${userId} - no quota reset needed (paid users use credit system)`);
      }
    } catch (error) {
      // Log but don't throw - this is a background sync, shouldn't break the main flow
      console.error('Error syncing Stripe subscription:', error);
    }
  }
}

// Note: SQL functions are now included in the pricing_schema.sql file
