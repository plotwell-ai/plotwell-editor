// Pricing Plans Configuration
// Stripe price IDs are set via environment variables per deployment

const currentPriceIds = {
  paid_monthly: process.env.STRIPE_PAID_MONTHLY_PRICE_ID || '',
  paid_yearly: process.env.STRIPE_PAID_YEARLY_PRICE_ID || '',
  additional_project: process.env.STRIPE_ADDON_PROJECT_PRICE_ID || '',
  additional_collaborator: process.env.STRIPE_ADDON_COLLABORATOR_PRICE_ID || '',
  additional_project_yearly: process.env.STRIPE_ADDON_PROJECT_YEARLY_PRICE_ID || '',
  additional_collaborator_yearly: process.env.STRIPE_ADDON_COLLABORATOR_YEARLY_PRICE_ID || '',
  ai_credits_pack: process.env.STRIPE_AI_CREDITS_PRICE_ID || ''
};

export interface PricingLimits {
  projects: number; // -1 = unlimited
  aiCreativeTasks: number; // Monthly AI Creative Tasks (scripts, concepts) - NOT images
  // Note: AI credits for images are now one-time purchases, not part of plan limits
  collaborators: number; // Team members
  prioritySupport: boolean;
  storyboards: boolean; // Visual storyboard creation
  versionControl: boolean; // Historical versions and restore functionality
  documents: number; // Document creation and management (-1 = unlimited)
  comments: boolean; // Comments and feedback system
}

export interface AddonPricing {
  additionalProjects?: {
    enabled: boolean;
    pricePerProject: number; // Monthly price per additional project
    yearlyPricePerProject: number; // Yearly price per additional project (billed annually)
    currency: string;
    maxAdditional?: number; // Maximum additional projects allowed (-1 = unlimited)
  };
  additionalCollaborators?: {
    enabled: boolean;
    pricePerCollaborator: number; // Monthly price per additional collaborator
    yearlyPricePerCollaborator: number; // Yearly price per additional collaborator (billed annually)
    currency: string;
    maxAdditional?: number; // Maximum additional collaborators allowed (-1 = unlimited)
  };
  // Note: AI credits are now one-time purchases via /api/ai-credits/purchase, not subscription addons
}

// AI Credits configuration (one-time purchases, not subscription-based)
export const AI_CREDITS_CONFIG = {
  // Available packs
  packs: {
    small: {
      id: 'small',
      credits: 200,
      priceEuros: 5,
      priceCents: 500,
      currency: 'eur'
    },
    large: {
      id: 'large',
      credits: 500,
      priceEuros: 10,
      priceCents: 1000,
      currency: 'eur'
    }
  },
  // Default pack (for backwards compatibility)
  pack: {
    credits: 200,        // 200 AI credits per pack
    priceEuros: 5,       // €5 per pack
    priceCents: 500,     // 500 cents
    currency: 'eur'
  },
  // Credit costs per operation
  costs: {
    image: 10,           // 10 credits per image generation
    video: 50,           // 50 credits per video (future)
    creative: 1,         // 1 credit per creative task (script generation, brainstorming, etc.)
  },
  // LAUNCH OFFER: Creative tasks are free during launch promotion
  // When launch ends, set enabled: false to charge 1 credit per creative task
  launchDiscount: {
    enabled: true,       // Set to false when launch offer ends
    creative: true,      // Creative tasks are free during launch (1 credit → 0)
  },
  // Only paid subscribers can purchase
  requiresPaidPlan: true
};

// Helper to get effective cost (applies launch discount if active)
export function getEffectiveCost(operationType: 'image' | 'video' | 'creative'): number {
  const baseCost = AI_CREDITS_CONFIG.costs[operationType] || 0;

  // Apply launch discount for creative tasks
  if (operationType === 'creative' && AI_CREDITS_CONFIG.launchDiscount.enabled && AI_CREDITS_CONFIG.launchDiscount.creative) {
    return 0; // Free during launch offer
  }

  return baseCost;
}

export interface PricingPlan {
  id: string;
  name: string;
  description: string;
  price: number; // Monthly price in EUR (updated from USD)
  yearlyPrice: number; // Yearly price in EUR (with discount)
  currency: string;
  popular: boolean;
  features: string[];
  limits: PricingLimits;
  addons?: AddonPricing; // Optional addon pricing for flexible plans
  stripePriceId?: string; // Stripe price ID for billing
  stripeYearlyPriceId?: string;
  status: 'active' | 'coming_soon' | 'deprecated';
}

export const PRICING_PLANS: Record<string, PricingPlan> = {
  free: {
    id: 'free',
    name: 'Free',
    description: 'Perfect for getting started',
    price: 0,
    yearlyPrice: 0,
    currency: 'EUR',
    popular: false,
    features: [
      '1 project',
      '2 documents',
      'Professional screenplay editor',
      'Industry-standard formatting',
      'PDF export',
      'Fountain & FDX import',
      'Writing statistics & reading mode',
      'Characters & locations',
      'Beat sheets & outline',
      'AI brainstorming chat',
      '40 AI Creative Tasks',  // ONE-TIME LIFETIME QUOTA - not monthly
      'Limited AI script doctor',
      'Limited concept & documents'
    ],
    limits: {
      projects: 1,
      aiCreativeTasks: 40,  // LIFETIME QUOTA - never resets, must upgrade when depleted
      // Note: AI credits are purchased separately (paid plan required)
      collaborators: 1,
      prioritySupport: false,
      storyboards: false,
      versionControl: false,
      documents: 2,
      comments: false
    },
    status: 'active'
  },

  paid: {
    id: 'paid',
    name: 'Pro',
    description: 'Full screenwriting & production planning suite',
    price: 9,
    yearlyPrice: 90, // €7.50/month equivalent, saves €18/year vs monthly
    currency: 'EUR',
    popular: true,
    features: [
      '4 projects (scale on demand)',
      '2 team collaborators (scale on demand)',
      'Unlimited documents',
      'Everything in Free, plus:',
      'TV Series (Seasons & Episodes)',
      'Version control & history',
      'Checkpoints & restore',
      'Character & location images (AI-generated)',
      'Unlimited concept & documents',
      'AI Creative Tasks (free during launch)',
      'AI credits for image generation (purchase separately)',
      'Unlimited AI script doctor',
      'Visual storyboards with AI generation',
      'Scene breakdown',
      'Shot lists',
      'Stripboard',
      'Filming locations',
      'Call sheets & scheduling',
      'Cast & crew management',
      'Budget tracking',
      'Real-time collaborative editing',
      'Comments & feedback system',
      'Public sharing links',
      'Priority support',
      '+€4/month or €40/year per additional project (+ VAT)',
      '+€4/month or €40/year per additional collaborator (+ VAT)'
    ],
    limits: {
      projects: 4, // Base includes 4 projects
      aiCreativeTasks: -1, // Uses credit system now (getEffectiveCost('creative') - 0 during launch, 1 after)
      // Note: AI credits are purchased separately via /api/ai-credits/purchase
      collaborators: 2, // Base includes 2 collaborators
      prioritySupport: true,
      storyboards: true,
      versionControl: true,
      documents: -1, // Unlimited
      comments: true
    },
    addons: {
      additionalProjects: {
        enabled: true,
        pricePerProject: 4, // €4/month per additional project (+ VAT)
        yearlyPricePerProject: 40, // €40/year per additional project (+ VAT) — discounted vs €4/month (€48/year)
        currency: 'EUR',
        maxAdditional: -1 // Unlimited additional projects
      },
      additionalCollaborators: {
        enabled: true,
        pricePerCollaborator: 4, // €4/month per additional collaborator (+ VAT)
        yearlyPricePerCollaborator: 40, // €40/year per additional collaborator (+ VAT) — discounted vs €4/month (€48/year)
        currency: 'EUR',
        maxAdditional: -1 // Unlimited additional collaborators
      }
      // Note: AI credits are now one-time purchases, not recurring addons
      // See AI_CREDITS_CONFIG and /api/ai-credits/purchase endpoint
    },
    stripePriceId: currentPriceIds.paid_monthly,
    stripeYearlyPriceId: currentPriceIds.paid_yearly,
    status: 'active'
  }

};

// Usage tracking types
export interface UsageStats {
  projectCount: number;
  aiCreativeTasksThisMonth: number;
  // Note: AI credits are tracked separately in user_quotas.ai_credits_balance
  collaboratorCount: number;
  documentCount: number;
}

// Helper functions
export function getPlanById(planId: string): PricingPlan | null {
  return PRICING_PLANS[planId] || null;
}

export function getActivePlans(): PricingPlan[] {
  return Object.values(PRICING_PLANS).filter(plan => plan.status === 'active');
}

export function getVisiblePlans(): PricingPlan[] {
  return Object.values(PRICING_PLANS).filter(plan => plan.status === 'active' || plan.status === 'coming_soon');
}

export function checkLimit(plan: PricingPlan, usage: UsageStats, limitType: keyof PricingLimits): boolean {
  switch (limitType) {
    case 'projects': {
      const limit = plan.limits.projects;
      return limit === -1 || usage.projectCount < limit;
    }
    case 'aiCreativeTasks': {
      const limit = plan.limits.aiCreativeTasks;
      return limit === -1 || usage.aiCreativeTasksThisMonth < limit;
    }
    // Note: AI credits are now checked via separate middleware (checkAICredits)
    case 'collaborators': {
      const limit = plan.limits.collaborators;
      return limit === -1 || usage.collaboratorCount < limit;
    }
    case 'documents': {
      const limit = plan.limits.documents;
      return limit === -1 || usage.documentCount < limit;
    }
    default:
      return true;
  }
}

export function getRemainingLimit(plan: PricingPlan, usage: UsageStats, limitType: keyof PricingLimits): number {
  switch (limitType) {
    case 'projects': {
      const limit = plan.limits.projects;
      if (limit === -1) return -1; // Unlimited
      return Math.max(0, limit - usage.projectCount);
    }
    case 'aiCreativeTasks': {
      const limit = plan.limits.aiCreativeTasks;
      if (limit === -1) return -1; // Unlimited
      return Math.max(0, limit - usage.aiCreativeTasksThisMonth);
    }
    // Note: AI credits balance is fetched separately from user_quotas.ai_credits_balance
    case 'collaborators': {
      const limit = plan.limits.collaborators;
      if (limit === -1) return -1; // Unlimited
      return Math.max(0, limit - usage.collaboratorCount);
    }
    case 'documents': {
      const limit = plan.limits.documents;
      if (limit === -1) return -1; // Unlimited
      return Math.max(0, limit - usage.documentCount);
    }
    default:
      return 0;
  }
}

// Stripe-specific helper functions
export function getStripePriceId(planId: string, billing: 'monthly' | 'yearly' = 'monthly'): string | null {
  const plan = getPlanById(planId);
  if (!plan) return null;
  
  return billing === 'yearly' ? plan.stripeYearlyPriceId || null : plan.stripePriceId || null;
}

export function getAddonStripePriceId(planId: string, addonType: 'projects' | 'collaborators', billingCycle: 'monthly' | 'yearly' = 'monthly'): string | null {
  // NEW SIMPLIFIED MODEL: Only 'paid' plan supports addons
  // Note: AI credits are one-time purchases via /api/ai-credits/purchase, not subscription addons
  if (planId === 'paid') {
    if (addonType === 'projects') {
      return billingCycle === 'yearly' ? currentPriceIds.additional_project_yearly : currentPriceIds.additional_project;
    }
    if (addonType === 'collaborators') {
      return billingCycle === 'yearly' ? currentPriceIds.additional_collaborator_yearly : currentPriceIds.additional_collaborator;
    }
  }

  return null;
}

// Get the AI credits pack Stripe price ID (one-time purchase)
export function getAICreditsPriceId(): string {
  return currentPriceIds.ai_credits_pack;
}

export function getPlanIdFromStripePrice(stripePriceId: string): string | null {
  const priceMapping: Record<string, string> = {};

  // Map from env-configured price IDs
  if (currentPriceIds.paid_monthly) priceMapping[currentPriceIds.paid_monthly] = 'paid';
  if (currentPriceIds.paid_yearly) priceMapping[currentPriceIds.paid_yearly] = 'paid';

  return priceMapping[stripePriceId] || null;
}

export function getAddonPriceForPlan(planId: string, addonType: 'additional_projects' | 'additional_collaborators', billingCycle: 'monthly' | 'yearly' = 'monthly'): number {
  const plan = getPlanById(planId);
  if (!plan?.addons) return 0;

  if (addonType === 'additional_projects' && plan.addons.additionalProjects?.enabled) {
    return billingCycle === 'yearly'
      ? plan.addons.additionalProjects.yearlyPricePerProject
      : plan.addons.additionalProjects.pricePerProject;
  }

  if (addonType === 'additional_collaborators' && plan.addons.additionalCollaborators?.enabled) {
    return billingCycle === 'yearly'
      ? plan.addons.additionalCollaborators.yearlyPricePerCollaborator
      : plan.addons.additionalCollaborators.pricePerCollaborator;
  }

  // Note: AI credits are one-time purchases, see AI_CREDITS_CONFIG
  return 0;
}

export function getAddonTypeFromPriceId(stripePriceId: string): 'additional_projects' | 'additional_collaborators' | null {
  // NEW SIMPLIFIED MODEL - unified pricing (monthly + yearly)
  // Note: AI credits are one-time purchases, not subscription addons
  if (stripePriceId === currentPriceIds.additional_project || stripePriceId === currentPriceIds.additional_project_yearly) {
    return 'additional_projects';
  }

  if (stripePriceId === currentPriceIds.additional_collaborator || stripePriceId === currentPriceIds.additional_collaborator_yearly) {
    return 'additional_collaborators';
  }

  return null;
}

// Addon price mapping for subscription items
export const ADDON_PRICE_IDS = {
  additional_projects: {
    paid: currentPriceIds.additional_project,
    paid_yearly: currentPriceIds.additional_project_yearly
  },
  additional_collaborators: {
    paid: currentPriceIds.additional_collaborator,
    paid_yearly: currentPriceIds.additional_collaborator_yearly
  }
  // Note: AI credits are one-time purchases, not recurring subscription addons
  // See AI_CREDITS_CONFIG and /api/ai-credits/purchase endpoint
};

// Helper function to get addon price ID for a specific plan and addon type
export function getAddonPriceId(planId: string, addonType: 'additional_projects' | 'additional_collaborators', billingCycle: 'monthly' | 'yearly' = 'monthly'): string | null {
  if (billingCycle === 'yearly') {
    return ADDON_PRICE_IDS[addonType][`${planId}_yearly` as keyof typeof ADDON_PRICE_IDS[typeof addonType]] || null;
  }
  return ADDON_PRICE_IDS[addonType][planId as keyof typeof ADDON_PRICE_IDS[typeof addonType]] || null;
}

// Export current price IDs for use in other modules
export { currentPriceIds };