// Pricing Plans Configuration
// Stripe price IDs are set via environment variables per deployment

const currentPriceIds = {
  // Base subscription (optional — only used if a paid plan is active)
  paid_monthly: process.env.STRIPE_PAID_MONTHLY_PRICE_ID || '',
  paid_yearly: process.env.STRIPE_PAID_YEARLY_PRICE_ID || '',
  // Expansion addons
  additional_project: process.env.STRIPE_ADDON_PROJECT_PRICE_ID || '',
  additional_collaborator: process.env.STRIPE_ADDON_COLLABORATOR_PRICE_ID || '',
  additional_project_yearly: process.env.STRIPE_ADDON_PROJECT_YEARLY_PRICE_ID || '',
  additional_collaborator_yearly: process.env.STRIPE_ADDON_COLLABORATOR_YEARLY_PRICE_ID || '',
  ai_credits_pack: process.env.STRIPE_AI_CREDITS_PRICE_ID || ''
};

export interface PricingLimits {
  // Expansion limits (paid addons unlock more)
  projects: number;        // -1 = unlimited
  collaborators: number;   // 0 = solo only

  // Fair use per-project caps (prevent abuse, real users never hit these)
  documents: number;       // -1 = unlimited
  storyboardPanels: number; // per project
  characters: number;      // per project
  locations: number;       // per project
  scriptVersions: number;  // saved versions kept per script

  // AI trial credits (one-time, never resets — buy more via credits)
  aiTrialCredits: number;  // lifetime one-time trial allotment for new users

  // Legacy fields — kept for backwards compatibility, no longer enforced
  aiCreativeTasks?: number;
  prioritySupport?: boolean;
  storyboards?: boolean;
  versionControl?: boolean;
  comments?: boolean;
  agentWriter?: boolean;
  production?: boolean;
}

export interface AddonPricing {
  additionalProjects: {
    enabled: boolean;
    pricePerProject: number;        // Monthly price per additional project
    yearlyPricePerProject: number;  // Yearly price per additional project (billed annually)
    currency: string;
    maxAdditional: number;          // -1 = unlimited
  };
  additionalCollaborators: {
    enabled: boolean;
    pricePerCollaborator: number;
    yearlyPricePerCollaborator: number;
    currency: string;
    maxAdditional: number;
  };
}

// AI Credits configuration (one-time purchases, open to all users)
export const AI_CREDITS_CONFIG = {
  packs: {
    small: {
      id: 'small',
      credits: 200,
      priceDollars: 5,
      priceCents: 500,
      currency: 'usd'
    },
    large: {
      id: 'large',
      credits: 500,
      priceDollars: 10,
      priceCents: 1000,
      currency: 'usd'
    },
    bulk: {
      id: 'bulk',
      credits: 1400,
      priceDollars: 20,
      priceCents: 2000,
      currency: 'usd'
    }
  },
  // Default pack (for backwards compatibility)
  pack: {
    credits: 200,
    priceDollars: 5,
    priceCents: 500,
    currency: 'usd'
  },
  // Credit costs per operation
  costs: {
    image: 10,       // per image generation
    video: 50,       // per video (future)
    creative: 1,     // per creative task (script gen, brainstorming, etc.)
    agent_step: 1,   // per agent scene step
  },
  // Open to all users — no paid plan required
  requiresPaidPlan: false,
  // Legacy field — kept for backwards compatibility
  launchDiscount: {
    enabled: false,
    creative: false,
  }
};

export function getEffectiveCost(operationType: 'image' | 'video' | 'creative' | 'agent_step'): number {
  return AI_CREDITS_CONFIG.costs[operationType] || 0;
}

export interface PricingPlan {
  id: string;
  name: string;
  description: string;
  price: number;
  yearlyPrice?: number;  // Yearly price in USD (billed annually)
  currency: string;
  popular?: boolean;
  features: string[];
  limits: PricingLimits;
  // Kept for backwards compatibility — use EXPANSION_PRICING for global addon pricing
  addons?: AddonPricing;
  stripePriceId?: string;
  stripeYearlyPriceId?: string;
  status: 'active' | 'coming_soon' | 'deprecated';
}

// Expansion addon pricing (independent of any base plan)
export const EXPANSION_PRICING: AddonPricing = {
  additionalProjects: {
    enabled: true,
    pricePerProject: 3,           // $3/month per additional project
    yearlyPricePerProject: 30,    // $30/year (~$2.50/month)
    currency: 'USD',
    maxAdditional: -1
  },
  additionalCollaborators: {
    enabled: true,
    pricePerCollaborator: 3,
    yearlyPricePerCollaborator: 30,
    currency: 'USD',
    maxAdditional: -1
  }
};

export const PRICING_PLANS: Record<string, PricingPlan> = {
  free: {
    id: 'free',
    name: 'Free',
    description: '1 project + 1 collaborator — all features included',
    price: 0,
    currency: 'USD',
    features: [
      '1 project + 1 collaborator included',
      '10 AI credits to get started',
      'Professional screenplay editor',
      'Visual storyboards',
      'Production planning suite',
      'PDF export, Fountain & FDX import/export',
      'Script Doctor',
      'Version history (last 5)',
      'Characters & locations',
      'Scene breakdown, shot lists, stripboard',
      'Budget tracking',
      'Add more projects or collaborators from $3/month',
      'Top up AI credits anytime',
    ],
    limits: {
      projects: 1,
      collaborators: 1,         // 1 collaborator included on free plan
      documents: -1,            // Unlimited
      storyboardPanels: 100,    // Fair use cap per project
      characters: 30,           // Fair use cap per project
      locations: 20,            // Fair use cap per project
      scriptVersions: 5,        // Keep last 5 saved versions
      aiTrialCredits: 10,       // One-time trial, never resets
    },
    status: 'active'
  },

  // Optional base subscription plan — activate when/if moving away from pure freemium.
  // To enable: set status to 'active' and configure STRIPE_PAID_MONTHLY/YEARLY_PRICE_ID env vars.
  // At $6/month this replaces the free tier as the entry point (1 project + 1 collaborator included).
  paid: {
    id: 'paid',
    name: 'Starter',
    description: 'For writers who need more than one project',
    price: 6,
    yearlyPrice: 60,  // $5/month equivalent
    currency: 'USD',
    popular: true,
    features: [
      '1 project included',
      '1 collaborator included',
      'Unlimited documents',
      'Unlimited storyboard panels',
      'Unlimited characters & locations',
      'Version history (last 20)',
      'AI credits (purchase as needed)',
      'Add more projects from $3/month',
      'Add more collaborators from $3/month',
    ],
    limits: {
      projects: 1,
      collaborators: 1,
      documents: -1,
      storyboardPanels: -1,
      characters: -1,
      locations: -1,
      scriptVersions: 20,
      aiTrialCredits: 0,        // No trial credits — user purchases directly
    },
    stripePriceId: currentPriceIds.paid_monthly,
    stripeYearlyPriceId: currentPriceIds.paid_yearly,
    status: 'coming_soon'       // Flip to 'active' to enable
  }
};

// Usage tracking types
export interface UsageStats {
  projectCount: number;
  collaboratorCount: number;
  documentCount: number;           // per project
  storyboardPanelCount?: number;   // per project (optional for callers that don't track yet)
  characterCount?: number;         // per project (optional for callers that don't track yet)
  locationCount?: number;          // per project (optional for callers that don't track yet)
  // Legacy field — kept for backwards compatibility
  aiCreativeTasksThisMonth?: number;
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
    case 'collaborators': {
      const limit = plan.limits.collaborators;
      return limit === -1 || usage.collaboratorCount < limit;
    }
    case 'documents': {
      const limit = plan.limits.documents;
      return limit === -1 || usage.documentCount < limit;
    }
    case 'storyboardPanels': {
      const limit = plan.limits.storyboardPanels;
      return limit === -1 || usage.storyboardPanelCount < limit;
    }
    case 'characters': {
      const limit = plan.limits.characters;
      return limit === -1 || usage.characterCount < limit;
    }
    case 'locations': {
      const limit = plan.limits.locations;
      return limit === -1 || usage.locationCount < limit;
    }
    default:
      return true;
  }
}

export function getRemainingLimit(plan: PricingPlan, usage: UsageStats, limitType: keyof PricingLimits): number {
  switch (limitType) {
    case 'projects': {
      const limit = plan.limits.projects;
      if (limit === -1) return -1;
      return Math.max(0, limit - usage.projectCount);
    }
    case 'collaborators': {
      const limit = plan.limits.collaborators;
      if (limit === -1) return -1;
      return Math.max(0, limit - usage.collaboratorCount);
    }
    case 'documents': {
      const limit = plan.limits.documents;
      if (limit === -1) return -1;
      return Math.max(0, limit - usage.documentCount);
    }
    case 'storyboardPanels': {
      const limit = plan.limits.storyboardPanels;
      if (limit === -1) return -1;
      return Math.max(0, limit - usage.storyboardPanelCount);
    }
    case 'characters': {
      const limit = plan.limits.characters;
      if (limit === -1) return -1;
      return Math.max(0, limit - usage.characterCount);
    }
    case 'locations': {
      const limit = plan.limits.locations;
      if (limit === -1) return -1;
      return Math.max(0, limit - usage.locationCount);
    }
    default:
      return 0;
  }
}

// Addon price ID helpers
export function getAddonStripePriceId(addonType: 'projects' | 'collaborators', billingCycle: 'monthly' | 'yearly' = 'monthly'): string | null {
  if (addonType === 'projects') {
    return billingCycle === 'yearly' ? currentPriceIds.additional_project_yearly : currentPriceIds.additional_project;
  }
  if (addonType === 'collaborators') {
    return billingCycle === 'yearly' ? currentPriceIds.additional_collaborator_yearly : currentPriceIds.additional_collaborator;
  }
  return null;
}

export function getAICreditsPriceId(): string {
  return currentPriceIds.ai_credits_pack;
}

export function getAddonTypeFromPriceId(stripePriceId: string): 'additional_projects' | 'additional_collaborators' | null {
  if (stripePriceId === currentPriceIds.additional_project || stripePriceId === currentPriceIds.additional_project_yearly) {
    return 'additional_projects';
  }
  if (stripePriceId === currentPriceIds.additional_collaborator || stripePriceId === currentPriceIds.additional_collaborator_yearly) {
    return 'additional_collaborators';
  }
  return null;
}

export function getAddonPrice(addonType: 'additional_projects' | 'additional_collaborators', billingCycle: 'monthly' | 'yearly' = 'monthly'): number {
  if (addonType === 'additional_projects') {
    return billingCycle === 'yearly'
      ? EXPANSION_PRICING.additionalProjects.yearlyPricePerProject
      : EXPANSION_PRICING.additionalProjects.pricePerProject;
  }
  if (addonType === 'additional_collaborators') {
    return billingCycle === 'yearly'
      ? EXPANSION_PRICING.additionalCollaborators.yearlyPricePerCollaborator
      : EXPANSION_PRICING.additionalCollaborators.pricePerCollaborator;
  }
  return 0;
}

// Maps Stripe price IDs back to plan IDs (used in webhook processing)
export function getPlanIdFromStripePrice(stripePriceId: string): string | null {
  if (stripePriceId && (stripePriceId === currentPriceIds.paid_monthly || stripePriceId === currentPriceIds.paid_yearly)) {
    return 'paid';
  }
  return null;
}

export function getStripePriceId(planId: string, billing: 'monthly' | 'yearly' = 'monthly'): string | null {
  const plan = getPlanById(planId);
  if (!plan) return null;
  return billing === 'yearly' ? plan.stripeYearlyPriceId || null : plan.stripePriceId || null;
}

export const ADDON_PRICE_IDS = {
  additional_projects: {
    monthly: currentPriceIds.additional_project,
    yearly: currentPriceIds.additional_project_yearly
  },
  additional_collaborators: {
    monthly: currentPriceIds.additional_collaborator,
    yearly: currentPriceIds.additional_collaborator_yearly
  }
};

// Backwards-compatibility aliases
// getAddonPriceId: returns Stripe price ID (string) for an addon type + billing cycle
export const getAddonPriceId = (_planId: string, addonType: 'additional_projects' | 'additional_collaborators', billingCycle: 'monthly' | 'yearly' = 'monthly'): string | null => {
  return ADDON_PRICE_IDS[addonType][billingCycle] || null;
};
// getAddonPriceForPlan: returns dollar amount for an addon type + billing cycle
export const getAddonPriceForPlan = (_planId: string, addonType: 'additional_projects' | 'additional_collaborators', billingCycle: 'monthly' | 'yearly' = 'monthly'): number => {
  return getAddonPrice(addonType, billingCycle);
};

export { currentPriceIds };
