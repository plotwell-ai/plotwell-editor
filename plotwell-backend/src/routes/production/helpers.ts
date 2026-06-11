import { Request } from 'express';
import { z } from 'zod';
import { OpenAI } from 'openai';
import { supabase } from '../../config/database';

export { supabase };
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 10 * 60 * 1000, // 10 minutes timeout for production analysis
});

// Helper function to get user ID from request
export function getUserId(req: Request): string | null {
  return req.user?.sub || req.user?.id || null;
}

/**
 * Helper: Check if user has access to a project (owner OR active collaborator)
 * Returns: { hasAccess: boolean, isOwner: boolean, role: string | null, canEdit: boolean }
 */
export async function checkProjectAccessForUser(projectId: string, userId: string): Promise<{
  hasAccess: boolean;
  isOwner: boolean;
  role: string | null;
  canEdit: boolean;
}> {
  // Check if user is the project owner
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, user_id')
    .eq('id', projectId)
    .eq('deleted', false)
    .single();

  if (projectError || !project) {
    return { hasAccess: false, isOwner: false, role: null, canEdit: false };
  }

  if (project.user_id === userId) {
    return { hasAccess: true, isOwner: true, role: 'owner', canEdit: true };
  }

  // Check if user is a collaborator
  const { data: collaborator, error: collabError } = await supabase
    .from('project_collaborators')
    .select('role, status')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (collabError || !collaborator) {
    return { hasAccess: false, isOwner: false, role: null, canEdit: false };
  }

  const canEdit = ['owner', 'admin', 'editor'].includes(collaborator.role);
  return { hasAccess: true, isOwner: false, role: collaborator.role, canEdit };
}

// Helper function to gather comprehensive project context for AI analysis
// Note: Access control should be verified BEFORE calling this function
export async function gatherProjectContext(projectId: string, userId: string) {
  // Fetch all relevant data in parallel for efficiency
  // Data is fetched by project_id only - access control is handled by the caller
  const [
    projectResult,
    castResult,
    crewResult,
    budgetResult,
    locationsResult,
    sceneCardsResult,
    scriptsResult,
    scheduleResult
  ] = await Promise.all([
    // Project details including genre, type, scale
    supabase
      .from('projects')
      .select('id, name, description, project_type, status, settings, production_country, production_region, currency, cost_multiplier')
      .eq('id', projectId)
      .single(),
    // Cast with rates
    supabase
      .from('production_cast')
      .select('*')
      .eq('project_id', projectId),
    // Crew with rates
    supabase
      .from('production_crew')
      .select('*')
      .eq('project_id', projectId),
    // Budget items
    supabase
      .from('production_budgets')
      .select('*')
      .eq('project_id', projectId)
      .order('category_name'),
    // Production locations
    supabase
      .from('production_locations')
      .select('*')
      .eq('project_id', projectId),
    // Scene cards with breakdown info
    supabase
      .from('scene_cards')
      .select('*')
      .eq('project_id', projectId)
      .order('scene_number'),
    // Scripts for scene content
    supabase
      .from('scripts')
      .select('id, title, scenes')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1),
    // Production schedule
    supabase
      .from('production_schedules')
      .select('*')
      .eq('project_id', projectId)
      .order('shoot_date')
  ]);

  const project = projectResult.data;
  const cast = castResult.data || [];
  const crew = crewResult.data || [];
  const budgetItems = budgetResult.data || [];
  const locations = locationsResult.data || [];
  const sceneCards = sceneCardsResult.data || [];
  const scripts = scriptsResult.data || [];
  const schedule = scheduleResult.data || [];

  // Calculate totals and metrics
  const totalBudget = budgetItems.reduce((sum, item) => sum + (item.total || 0), 0);
  const totalShootDays = sceneCards.reduce((sum, scene) => sum + (scene.estimated_shoot_days || 0), 0);
  const scheduledDays = new Set(schedule.map(s => s.shoot_date)).size;

  // Calculate cast total cost
  const castTotalCost = cast.reduce((sum, c) => {
    const days = totalShootDays || 1;
    return sum + ((c.rate_per_day || 0) * days);
  }, 0);

  // Calculate crew total cost
  const crewTotalCost = crew.reduce((sum, c) => {
    const days = totalShootDays || 1;
    return sum + ((c.rate_per_day || 0) * days);
  }, 0);

  // Categorize budget by above/below the line
  const aboveTheLineCategories = ['Story & Rights', 'Producer', 'Director', 'Cast', 'Writers', 'Development'];
  const aboveTheLineBudget = budgetItems
    .filter(item => aboveTheLineCategories.some(cat => item.category_name?.toLowerCase().includes(cat.toLowerCase())))
    .reduce((sum, item) => sum + (item.total || 0), 0);
  const belowTheLineBudget = totalBudget - aboveTheLineBudget;

  // Count scene complexity distribution
  const complexityCount = {
    simple: sceneCards.filter(s => s.complexity === 'simple').length,
    medium: sceneCards.filter(s => s.complexity === 'medium').length,
    complex: sceneCards.filter(s => s.complexity === 'complex').length
  };

  // Count day vs night scenes
  const timeOfDayCount = {
    day: sceneCards.filter(s => s.time_of_day === 'day').length,
    night: sceneCards.filter(s => s.time_of_day === 'night').length,
    dawn: sceneCards.filter(s => s.time_of_day === 'dawn').length,
    dusk: sceneCards.filter(s => s.time_of_day === 'dusk').length
  };

  // Extract scene descriptions from script if available
  let sceneDescriptions: Record<number, string> = {};
  if (scripts.length > 0 && scripts[0].scenes) {
    try {
      const parsedScenes = typeof scripts[0].scenes === 'string'
        ? JSON.parse(scripts[0].scenes)
        : scripts[0].scenes;
      if (Array.isArray(parsedScenes)) {
        parsedScenes.forEach((scene: any, index: number) => {
          sceneDescriptions[index + 1] = scene.content || scene.description || '';
        });
      }
    } catch (e) {
      console.error('Error parsing scenes:', e);
    }
  }

  return {
    project,
    cast,
    crew,
    budgetItems,
    locations,
    sceneCards,
    scripts,
    schedule,
    metrics: {
      totalBudget,
      totalShootDays,
      scheduledDays,
      castTotalCost,
      crewTotalCost,
      aboveTheLineBudget,
      belowTheLineBudget,
      sceneCount: sceneCards.length,
      complexityCount,
      timeOfDayCount,
      costPerShootDay: totalShootDays > 0 ? Math.round(totalBudget / totalShootDays) : 0,
      averageSceneBudget: sceneCards.length > 0 ? Math.round(totalBudget / sceneCards.length) : 0
    },
    sceneDescriptions
  };
}

// Industry benchmark data for budget analysis
export const INDUSTRY_BENCHMARKS = {
  // Budget distribution benchmarks (percentages)
  distribution: {
    aboveTheLine: { min: 15, ideal: 25, max: 40 },  // Story, Director, Producers, Cast
    belowTheLine: { min: 40, ideal: 55, max: 70 },  // Crew, Equipment, Locations
    postProduction: { min: 10, ideal: 15, max: 25 },
    contingency: { min: 5, ideal: 10, max: 15 }
  },
  // Cost per shooting day benchmarks by project scale
  costPerDay: {
    micro: { min: 500000, max: 2000000, label: 'Micro Budget (<$500K total)' },       // $5K-$20K/day
    low: { min: 2000000, max: 5000000, label: 'Low Budget ($500K-$2M total)' },       // $20K-$50K/day
    moderate: { min: 5000000, max: 15000000, label: 'Moderate Budget ($2M-$10M)' },   // $50K-$150K/day
    studio: { min: 15000000, max: 50000000, label: 'Studio Budget ($10M+)' }          // $150K-$500K/day
  },
  // Crew rate ranges (in cents per day) - US market
  crewRates: {
    director: { min: 100000, max: 500000 },           // $1,000-$5,000/day
    dp: { min: 80000, max: 300000 },                  // $800-$3,000/day
    gaffer: { min: 50000, max: 150000 },              // $500-$1,500/day
    soundMixer: { min: 60000, max: 120000 },          // $600-$1,200/day
    productionDesigner: { min: 60000, max: 200000 },  // $600-$2,000/day
    editor: { min: 50000, max: 200000 },              // $500-$2,000/day
    pa: { min: 15000, max: 30000 }                    // $150-$300/day
  },
  // Cast rate ranges by category (in cents per day)
  castRates: {
    lead: { min: 100000, max: 5000000 },              // $1,000-$50,000/day
    supporting: { min: 50000, max: 200000 },          // $500-$2,000/day
    dayPlayer: { min: 20000, max: 80000 },            // $200-$800/day (SAG minimum ~$1,082/day)
    background: { min: 10000, max: 25000 }            // $100-$250/day
  }
};

// Validation schemas
export const SceneAnalysisSchema = z.object({
  projectId: z.string().uuid(),
  scriptContent: z.string(),
  projectType: z.enum(['film', 'series', 'short']).optional()
});

export const BudgetOptimizeSchema = z.object({
  projectId: z.string().uuid(),
  sceneCards: z.array(z.object({
    number: z.number(),
    heading: z.string(),
    characters: z.array(z.string()),
    location: z.string(),
    timeOfDay: z.enum(['day', 'night', 'dawn', 'dusk']),
    complexity: z.enum(['simple', 'medium', 'complex']),
    estimatedShootDays: z.number(),
    budget: z.number()
  })),
  totalBudget: z.number(),
  language: z.string().optional(),
  goal: z.enum(['reduce_cost', 'increase_budget']).optional(),
  targetPercentage: z.number().min(5).max(50).optional(),
  categories: z.union([
    z.array(z.string()),
    z.object({
      castTalent: z.boolean().optional(),
      crewEquipment: z.boolean().optional(),
      postServices: z.boolean().optional()
    })
  ]).optional(),
  budget: z.array(z.object({
    name: z.string(),
    items: z.array(z.any()),
    total: z.number()
  })).optional()
});

export const ShotListGenerateSchema = z.object({
  sceneHeading: z.string(),
  sceneContent: z.string(),
  characters: z.array(z.string()),
  complexity: z.enum(['simple', 'medium', 'complex'])
});

export const ScheduleOptimizeSchema = z.object({
  projectId: z.string().uuid(),
  scenes: z.array(z.object({
    number: z.number(),
    location: z.string(),
    timeOfDay: z.enum(['day', 'night', 'dawn', 'dusk']),
    characters: z.array(z.string()),
    estimatedShootDays: z.number()
  }))
});
