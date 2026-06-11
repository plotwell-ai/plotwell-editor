import { Request, Response, NextFunction } from 'express';
import { PricingService } from '../services/pricingService';
import { createClient } from '@supabase/supabase-js';
import { AI_CREDITS_CONFIG, getEffectiveCost } from '../config/pricingPlans';

// Initialize Supabase client lazily to ensure env vars are loaded
let supabase: ReturnType<typeof createClient> | null = null;
const getSupabaseClient = () => {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Missing Supabase environment variables');
    }
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
};

export interface PricingRequest extends Request {
  pricingService?: PricingService;
  userId?: string;
}

/**
 * Middleware to add pricing service to request
 */
export const addPricingService = (req: PricingRequest, res: Response, next: NextFunction) => {
  req.pricingService = new PricingService(getSupabaseClient());
  next();
};

/**
 * Middleware to check if user can create projects
 */
export const checkProjectLimit = async (req: PricingRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId; // Should be set by auth middleware
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const pricingService = req.pricingService || new PricingService(getSupabaseClient());
    const result = await pricingService.canPerformAction(userId, 'create_project');

    if (!result.allowed) {
      return res.status(403).json({ 
        error: 'Project limit exceeded',
        message: result.reason,
        type: 'LIMIT_EXCEEDED',
        action_required: 'upgrade'
      });
    }

    next();
  } catch (error) {
    console.error('Error checking project limit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Middleware to check if user can use AI Creative Tasks
 *
 * All users (free and paid) use the same credit system.
 * Free users receive a one-time trial allotment (aiTrialCredits) on signup.
 * After trial credits are exhausted, any user can purchase more.
 *
 * Supports collaboration - if user is a collaborator on a project,
 * uses the project owner's credits instead of the user's own.
 */
export const checkAICreativeTaskLimit = async (req: PricingRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Extract project_id from request (could be in query, body, or params)
    const projectId = req.query.project_id || req.body.project_id || req.params.project_id;

    const pricingService = req.pricingService || new PricingService(getSupabaseClient());
    let targetUserId = userId;
    let isCollaborator = false;

    // If we have a project_id, check if user is a collaborator
    if (projectId) {
      const supabaseClient = getSupabaseClient();

      const { data: project } = await supabaseClient
        .from('projects')
        .select('user_id')
        .eq('id', projectId)
        .single();

      if (project && project.user_id !== userId) {
        const { data: collaborator } = await supabaseClient
          .from('project_collaborators')
          .select('project_id')
          .eq('project_id', projectId)
          .eq('user_id', userId)
          .eq('status', 'active')
          .single();

        if (collaborator) {
          isCollaborator = true;
          targetUserId = project.user_id as string;
        }
      }
    }

    // Ensure free trial credits are seeded for new users, then check balance
    const balance = await pricingService.ensureFreeUserCredits(targetUserId);
    const creativeCost = getEffectiveCost('creative');

    if (balance < creativeCost) {
      return res.status(403).json({
        error: 'Insufficient AI credits',
        message: `Creative tasks require ${creativeCost} credit(s). Your balance: ${balance}. Purchase more credits to continue.`,
        type: 'INSUFFICIENT_CREDITS',
        credits_required: creativeCost,
        credits_balance: balance,
        action_required: 'purchase_credits',
        is_collaborator: isCollaborator
      });
    }

    next();
  } catch (error) {
    console.error('Error checking AI Creative Task limit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Backward compatibility alias
export const checkAIGenerationLimit = checkAICreativeTaskLimit;

/**
 * Middleware to track AI generation usage after successful generation
 *
 * NEW SYSTEM (January 2025):
 * - FREE users: Increment ai_generations_used counter (lifetime quota)
 * - PAID users: Consume credits via consumeAICredits (getEffectiveCost('creative'))
 *
 * Supports collaboration - tracks usage against project owner's quota if user is a collaborator
 */
export const trackAIUsage = async (req: PricingRequest, res: Response, next: NextFunction) => {
  // Store original res.json to intercept successful responses
  const originalJson = res.json;

  res.json = function(data: any) {
    // If the response was successful, track the usage
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const userId = req.userId;
      if (userId) {
        // Extract project_id to determine if this is a collaboration
        const projectId = req.query.project_id || req.body.project_id || req.params.project_id;

        const pricingService = req.pricingService || new PricingService(getSupabaseClient());

        // Check if user is a collaborator and track against project owner's quota
        if (projectId) {
          checkCollaborationAndTrackCreative(userId, projectId as string, pricingService);
        } else {
          // No project ID, track against user's own quota
          trackCreativeUsageForUser(userId, pricingService);
        }
      }
    }

    // Call the original res.json
    return originalJson.call(this, data);
  };

  next();
};

/**
 * Helper to track creative usage for a specific user.
 * All users deduct from the unified ai_credits_balance pool.
 */
const trackCreativeUsageForUser = async (userId: string, pricingService: PricingService) => {
  try {
    await pricingService.trackAIGeneration(userId);

    const creditCost = getEffectiveCost('creative');
    if (creditCost > 0) {
      await pricingService.consumeAICredits(userId, creditCost, 'Creative task');
    }
  } catch (err) {
    console.error('Error tracking creative usage:', err);
  }
};

/**
 * Manually track creative AI usage for routes that use SSE (non-JSON responses).
 * Handles collaboration: charges the project owner's quota if user is a collaborator.
 * Call this after successful AI generation in SSE routes instead of relying on trackAIUsage.
 */
export const manualTrackCreativeUsage = async (userId: string, projectId: string, pricingService?: PricingService) => {
  const service = pricingService || new PricingService(getSupabaseClient());
  await checkCollaborationAndTrackCreative(userId, projectId, service);
};

/**
 * Helper function to check collaboration and track creative usage accordingly
 * Uses the new plan-based system (free = lifetime counter, paid = credits)
 */
const checkCollaborationAndTrackCreative = async (userId: string, projectId: string, pricingService: PricingService) => {
  try {
    const supabaseClient = getSupabaseClient();

    // Check if user owns this project
    const { data: project } = await supabaseClient
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .single();

    let targetUserId = userId;

    if (project && project.user_id !== userId) {
      // User doesn't own the project, check if they're a collaborator
      const { data: collaborator } = await supabaseClient
        .from('project_collaborators')
        .select('project_id')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      if (collaborator) {
        // User is a collaborator, track against project owner's quota
        targetUserId = project.user_id as string;
      }
    }

    // Use the new plan-based tracking logic
    await trackCreativeUsageForUser(targetUserId, pricingService);
  } catch (err) {
    console.error('Error tracking creative usage with collaboration check:', err);
  }
};

/**
 * Middleware to consume AI credits after successful image/video generation
 * Now supports collaboration - consumes from project owner's credits if user is a collaborator
 */
export const trackAICreditsUsage = async (req: PricingRequest, res: Response, next: NextFunction) => {
  // Store original res.json to intercept successful responses
  const originalJson = res.json;

  res.json = function(data: any) {
    // If the response was successful, consume the credits
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const userId = req.userId;
      const creditsRequired = req.aiCreditsRequired || AI_CREDITS_CONFIG.costs.image;
      const usageDescription = req.aiCreditsUsageDescription || 'Image generation';

      if (userId) {
        // Extract project_id to determine if this is a collaboration
        const projectId = req.query.project_id || req.body.project_id || req.params.project_id;

        const pricingService = req.pricingService || new PricingService(getSupabaseClient());

        // Check if user is a collaborator and consume from project owner's credits
        if (projectId) {
          checkCollaborationAndConsumeCredits(userId, projectId as string, creditsRequired, pricingService, usageDescription);
        } else {
          // No project ID, consume from user's own credits
          pricingService.consumeAICredits(userId, creditsRequired, usageDescription).catch((err: Error) => {
            console.error('Error consuming AI credits:', err);
          });
        }
      }
    }

    // Call the original res.json
    return originalJson.call(this, data);
  };

  next();
};

// Alias for backwards compatibility
export const trackImageUsage = trackAICreditsUsage;

/**
 * Helper function to check collaboration and consume AI credits accordingly
 */
const checkCollaborationAndConsumeCredits = async (userId: string, projectId: string, creditsRequired: number, pricingService: PricingService, usageDescription = 'Image generation') => {
  try {
    const supabaseClient = getSupabaseClient();

    // Check if user owns this project
    const { data: project } = await supabaseClient
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .single();

    let targetUserId = userId;

    if (project && project.user_id !== userId) {
      // User doesn't own the project, check if they're a collaborator
      const { data: collaborator } = await supabaseClient
        .from('project_collaborators')
        .select('project_id')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      if (collaborator) {
        // User is a collaborator, consume from project owner's credits
        targetUserId = project.user_id as string;
      }
    }

    await pricingService.consumeAICredits(targetUserId, creditsRequired, usageDescription, {
      project_id: projectId,
      initiated_by: userId
    });
  } catch (err) {
    console.error('Error consuming AI credits with collaboration check:', err);
  }
};

/**
 * Middleware to check if user can add collaborators
 */
export const checkCollaboratorLimit = async (req: PricingRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const pricingService = req.pricingService || new PricingService(getSupabaseClient());
    const result = await pricingService.canPerformAction(userId, 'add_collaborator');

    if (!result.allowed) {
      return res.status(403).json({ 
        error: 'Collaborator limit exceeded',
        message: result.reason,
        type: 'LIMIT_EXCEEDED',
        action_required: 'upgrade'
      });
    }

    next();
  } catch (error) {
    console.error('Error checking collaborator limit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Middleware to extract user ID from existing auth middleware
 */
export const extractUserId = (req: PricingRequest, res: Response, next: NextFunction) => {
  try {
    // Use the user info that was already set by the requireAuth middleware
    const user = req.user;
    
    if (!user || !user.id) {
      return res.status(401).json({ error: 'User not authenticated or missing user ID' });
    }

    req.userId = user.id;
    next();
  } catch (error) {
    console.error('Error extracting user ID:', error);
    res.status(401).json({ error: 'Invalid authentication' });
  }
};

/**
 * Middleware to check if user has write permissions on a project
 * Blocks viewers from making write operations
 */
export const checkWritePermissions = async (req: PricingRequest, res: Response, next: NextFunction) => {
  try {
    
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    let projectId;
    try {
      projectId = req.query?.project_id || req.body?.project_id || req.params?.project_id;
    } catch (error) {
      console.error('❌ Error extracting project_id in checkWritePermissions:', error);
      return res.status(500).json({ error: 'Internal error extracting project_id' });
    }
    
    // If no direct project_id, try to get it from storyboard panel
    if (!projectId && req.params?.id && (req.route?.path?.includes('storyboard') || req.originalUrl?.includes('storyboard'))) {
      const supabaseClient = getSupabaseClient();
      
      const { data: panel, error: panelError } = await supabaseClient
        .from('storyboard_panels')
        .select('project_id')
        .eq('id', req.params.id)
        .single();
      
      if (panelError) {
        console.error('❌ Error fetching storyboard panel for permissions check:', panelError);
        // For DELETE operations, if the panel doesn't exist, let the route handler deal with it
        if (req.method === 'DELETE' && panelError.code === 'PGRST116') {
          return next(); // Let the route handler return 404
        }
        return res.status(404).json({ error: 'Storyboard panel not found' });
      }
      
      if (!panel) {
        console.error('❌ Panel is null/undefined');
        // For DELETE operations, if the panel doesn't exist, let the route handler deal with it
        if (req.method === 'DELETE') {
          return next(); // Let the route handler return 404
        }
        return res.status(404).json({ error: 'Storyboard panel not found' });
      }
      
      if (!panel.project_id) {
        console.error('❌ Panel exists but no project_id:', panel);
        return res.status(400).json({ error: 'Invalid storyboard panel - no project_id' });
      }
      
      projectId = panel.project_id;
      
      // Add project_id to request for other middleware
      if (!req.body) req.body = {};
      req.body.project_id = projectId;
    }
    
    if (!projectId) {
      return res.status(400).json({ error: 'Project ID required for write operations' });
    }

    const supabaseClient = getSupabaseClient();
    
    // Check if user owns this project (owners always have write access)
    const { data: project, error: projectError } = await supabaseClient
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .single();

    if (project && project.user_id === userId) {
      return next();
    }

    // Check if user is a collaborator and their role
    const { data: collaborator, error: collabError } = await supabaseClient
      .from('project_collaborators')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (collabError || !collaborator) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }

    // Check if collaborator has write permissions (viewers are read-only)
    if (collaborator.role === 'viewer') {
      return res.status(403).json({ 
        error: 'Read-only access - viewers cannot make changes',
        role: 'viewer',
        action_required: 'contact_owner_for_permissions'
      });
    }

    next();
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Middleware to check if user has available AI credits
 * AI credits are one-time purchases that never expire
 * Now supports collaboration - if user is a collaborator on a project,
 * uses the project owner's credits instead of the user's own
 */
export const checkAICredits = async (req: PricingRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Determine how many credits are needed for this operation
    // Default to image cost (10 credits), can be overridden via request body
    const creditsRequired = req.body.ai_credits_required || AI_CREDITS_CONFIG.costs.image;

    // Extract project_id from request (could be in query, body, or params)
    const projectId = req.query.project_id || req.body.project_id || req.params.project_id;

    const pricingService = req.pricingService || new PricingService(getSupabaseClient());
    let targetUserId = userId; // Default to the requesting user
    let isCollaborator = false;

    // If we have a project_id, check if user is a collaborator
    if (projectId) {
      const supabaseClient = getSupabaseClient();

      // First check if user owns this project
      const { data: project, error: projectError } = await supabaseClient
        .from('projects')
        .select('user_id')
        .eq('id', projectId)
        .single();

      if (project && project.user_id !== userId) {
        // User doesn't own the project, check if they're a collaborator
        const { data: collaborator, error: collabError } = await supabaseClient
          .from('project_collaborators')
          .select('project_id')
          .eq('project_id', projectId)
          .eq('user_id', userId)
          .eq('status', 'active')
          .single();

        if (collaborator && !collabError) {
          // User is a collaborator, use project owner's credits
          isCollaborator = true;
          targetUserId = project.user_id as string;
        }
      }
    }

    // Check AI credits balance
    const balance = await pricingService.getAICreditsBalance(targetUserId);

    if (balance < creditsRequired) {
      return res.status(403).json({
        error: 'Insufficient AI credits',
        message: `This operation requires ${creditsRequired} AI credits. Your balance: ${balance}. Purchase more credits to continue.`,
        type: 'INSUFFICIENT_CREDITS',
        credits_required: creditsRequired,
        credits_balance: balance,
        action_required: 'purchase_credits',
        is_collaborator: isCollaborator
      });
    }

    // Store target user ID for usage tracking (preserve original for audit)
    req.originalUserId = req.userId;
    req.targetUserId = targetUserId;
    // Store credits required for tracking after successful operation
    req.aiCreditsRequired = creditsRequired;

    next();
  } catch (error) {
    console.error('Error checking AI credits:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Keep old name as alias for backwards compatibility during migration
export const checkImageCredits = checkAICredits;

/**
 * Feature access middleware — all features are available to all users.
 * Kept as a passthrough so existing route registrations don't need to change.
 * Feature gating can be re-introduced here if a paid plan is activated.
 */
export const requireFeature = (_feature: string) => {
  return (_req: PricingRequest, _res: Response, next: NextFunction) => {
    next();
  };
};
