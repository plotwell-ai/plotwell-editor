/**
 * Production Analysis Prompts
 * Source: routes/production/analysis.ts
 */

import { PromptConfig } from './types';

// =============================================================================
// CONFIGS
// =============================================================================

export const SHOT_LIST_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 1500,
  requestType: 'generation',
};

export const BUDGET_OPTIMIZATION_CONFIG: PromptConfig = {
  version: 'v1',
  model: null, // Uses AI router
  temperature: 0.4,
  maxTokens: 6000,
  requestType: 'extraction',
};

// =============================================================================
// SYSTEM MESSAGES
// =============================================================================

export function buildBudgetOptimizationSystem(isReduceCost: boolean, targetLanguage: string): string {
  return `You are an expert film Line Producer with extensive experience in budget ${isReduceCost ? 'optimization and cost reduction' : 'allocation and production value maximization'}. Analyze production budgets and provide specific, data-driven recommendations ${isReduceCost ? 'to reduce costs' : 'to maximize production quality'}. Always output valid JSON with no markdown. All monetary values in WHOLE DOLLARS (not cents). All text in ${targetLanguage}.`;
}

// =============================================================================
// SHOT LIST GENERATION
// =============================================================================

interface ShotListParams {
  sceneHeading: string;
  sceneContent: string;
  characters: string[];
  complexity: string;
}

export function buildShotListPrompt(params: ShotListParams): string {
  return `Generate a professional shot list for this scene. Return ONLY a valid JSON array, no markdown, no explanation.

SCENE: ${params.sceneHeading}
CHARACTERS: ${params.characters.join(', ') || 'none specified'}
COMPLEXITY: ${params.complexity}
SCENE CONTENT: ${params.sceneContent || '(no content provided)'}

Return a JSON array where each shot has EXACTLY these fields:
- shot_type: one of "wide-shot", "medium-shot", "close-up", "extreme-close-up", "over-shoulder", "point-of-view", "extreme-wide", "high-angle", "low-angle", "tracking", "insert", "cutaway", "two-shot"
- camera_movement: one of "static", "pan", "tilt", "dolly", "dolly-in", "dolly-out", "handheld", "steadicam", "crane", "zoom-in", "zoom-out"
- description: string describing what the shot captures
- duration_seconds: integer (2-10 typical)
- priority: one of "essential", "important", "optional"
- equipment: string (e.g. "Tripod", "Dolly track", "Handheld rig")
- lighting: string (e.g. "Natural light", "Key light + fill", "Practical lamp")

Example: [{"shot_type":"wide-shot","camera_movement":"static","description":"Establishes the bedroom at night","duration_seconds":5,"priority":"essential","equipment":"Tripod","lighting":"Practical lamp + moonlight"}]`;
}

// =============================================================================
// BUDGET OPTIMIZATION
// =============================================================================

interface BudgetOptimizationParams {
  targetLanguage: string;
  goalDescription: string;
  categories: string[];
  isReduceCost: boolean;
  targetPercentage: number;
  targetAmount: number;
  project: any;
  projectScale: string;
  totalBudget: number;
  metrics: any;
  aboveTheLinePercent: number;
  belowTheLinePercent: number;
  budgetByCategory: Record<string, { items: any[]; total: number }>;
  sceneCards: any[];
  sceneDescriptions: Record<number, string>;
  cast: any[];
  crew: any[];
  locations: any[];
}

export function buildBudgetOptimizationPrompt(params: BudgetOptimizationParams): string {
  const {
    targetLanguage, goalDescription, categories, isReduceCost, targetPercentage,
    targetAmount, project, projectScale, totalBudget, metrics,
    aboveTheLinePercent, belowTheLinePercent, budgetByCategory,
    sceneCards, sceneDescriptions, cast, crew, locations,
  } = params;

  return `You are an expert film production Line Producer with 20+ years of experience optimizing budgets for indie and studio productions. Analyze this production budget and provide SPECIFIC, ACTIONABLE recommendations.

IMPORTANT: All recommendation text MUST be in ${targetLanguage}. JSON keys stay in English.

${'═'.repeat(63)}
OPTIMIZATION GOAL
${'═'.repeat(63)}
${goalDescription}
Focus Categories: ${categories.join(', ')}

${'═'.repeat(63)}
PROJECT OVERVIEW
${'═'.repeat(63)}
Project: ${project?.name || 'Untitled'}
Type: ${project?.project_type || 'film'}
Scale: ${projectScale} budget production
Production Location: ${project?.production_country || 'Not specified'}
Currency: ${project?.currency || 'USD'}

TOTAL BUDGET: $${(totalBudget / 100).toLocaleString()}
Total Shoot Days: ${metrics.totalShootDays}
Cost Per Shoot Day: $${(metrics.costPerShootDay / 100).toLocaleString()}
Average Cost Per Scene: $${(metrics.averageSceneBudget / 100).toLocaleString()}

${'═'.repeat(63)}
BUDGET DISTRIBUTION ANALYSIS
${'═'.repeat(63)}
Above-the-Line: $${(metrics.aboveTheLineBudget / 100).toLocaleString()} (${aboveTheLinePercent}%)
Below-the-Line: $${(metrics.belowTheLineBudget / 100).toLocaleString()} (${belowTheLinePercent}%)

Industry Benchmark: Above-the-line should be 15-40% of total budget.
${aboveTheLinePercent > 40 ? '⚠️ WARNING: Above-the-line costs are high!' : aboveTheLinePercent < 15 ? '✓ Above-the-line costs are lean' : '✓ Within normal range'}

BUDGET BY CATEGORY:
${Object.entries(budgetByCategory).map(([cat, data]) => {
  const percent = totalBudget > 0 ? Math.round((data.total / totalBudget) * 100) : 0;
  return `${cat}: $${(data.total / 100).toLocaleString()} (${percent}%)
  ${data.items.slice(0, 3).map(item => `  - ${item.item_name}: $${((item.total || 0) / 100).toLocaleString()}`).join('\n')}${data.items.length > 3 ? `\n  ... and ${data.items.length - 3} more items` : ''}`;
}).join('\n\n')}

${'═'.repeat(63)}
SCENE ANALYSIS (${sceneCards.length} scenes)
${'═'.repeat(63)}
Complexity Distribution:
- Simple scenes: ${metrics.complexityCount.simple} (${Math.round(metrics.complexityCount.simple / sceneCards.length * 100) || 0}%)
- Medium scenes: ${metrics.complexityCount.medium} (${Math.round(metrics.complexityCount.medium / sceneCards.length * 100) || 0}%)
- Complex scenes: ${metrics.complexityCount.complex} (${Math.round(metrics.complexityCount.complex / sceneCards.length * 100) || 0}%)

Time of Day Distribution:
- Day scenes: ${metrics.timeOfDayCount.day} (cheaper to shoot)
- Night scenes: ${metrics.timeOfDayCount.night} (typically 20-30% more expensive)
- Dawn/Dusk: ${metrics.timeOfDayCount.dawn + metrics.timeOfDayCount.dusk} (limited shooting windows)

DETAILED SCENE BREAKDOWN:
${sceneCards.map((scene: any) => {
  const desc = sceneDescriptions[scene.scene_number] || '';
  return `Scene ${scene.scene_number || scene.number}: ${scene.heading}
  Location: ${scene.location} | Time: ${scene.time_of_day || scene.timeOfDay} | Complexity: ${scene.complexity}
  Characters: ${Array.isArray(scene.characters) ? scene.characters.join(', ') : 'N/A'}
  Est. Days: ${scene.estimated_shoot_days || scene.estimatedShootDays} | Budget: $${((scene.budget || 0) / 100).toLocaleString()}
  ${desc ? `Content: ${desc.substring(0, 200)}...` : ''}`;
}).join('\n\n')}

${'═'.repeat(63)}
CAST (${cast.length} members) - Total Est. Cost: $${(metrics.castTotalCost / 100).toLocaleString()}
${'═'.repeat(63)}
${cast.map(c => {
  const totalCost = (c.rate_per_day || 0) * (metrics.totalShootDays || 1);
  return `${c.character_name} (${c.actor_name || 'TBD'})
  Category: ${c.category} | Rate: $${((c.rate_per_day || 0) / 100).toLocaleString()}/day | Est. Total: $${(totalCost / 100).toLocaleString()}`;
}).join('\n')}

${'═'.repeat(63)}
CREW (${crew.length} members) - Total Est. Cost: $${(metrics.crewTotalCost / 100).toLocaleString()}
${'═'.repeat(63)}
${crew.map(c => {
  const totalCost = (c.rate_per_day || 0) * (metrics.totalShootDays || 1);
  return `${c.name || 'TBD'} - ${c.role} (${c.department})
  Rate: $${((c.rate_per_day || 0) / 100).toLocaleString()}/day | Est. Total: $${(totalCost / 100).toLocaleString()}`;
}).join('\n')}

${'═'.repeat(63)}
LOCATIONS (${locations.length})
${'═'.repeat(63)}
${locations.map(loc => `${loc.name} (${loc.location_type}): $${((loc.estimated_cost || 0) / 100).toLocaleString()}
  ${loc.address || ''} ${loc.notes ? `| Notes: ${loc.notes}` : ''}`).join('\n')}

${'═'.repeat(63)}
OPTIMIZATION TASK
${'═'.repeat(63)}
${isReduceCost ? `Analyze this budget and provide SPECIFIC, ACTIONABLE recommendations to REDUCE COSTS. For each recommendation:
1. Identify the EXACT budget items or scenes that can be optimized
2. Calculate REALISTIC savings based on the actual numbers provided (target: ${targetPercentage}% = $${(targetAmount / 100).toLocaleString()})
3. Explain the trade-offs or risks
4. Prioritize by impact vs. effort

⚠️ IMPORTANT: ONLY analyze and provide recommendations for these SELECTED categories: [${categories.join(', ')}]
DO NOT include recommendations for categories not in this list.

${categories.includes('cast') ? `CAST & TALENT optimizations:
- Cast efficiency (minimizing actor days, combining roles where appropriate)
- Talent negotiations and scheduling` : ''}
${categories.includes('crew') ? `CREW & EQUIPMENT optimizations:
- Crew optimization (identifying overstaffing, multi-role opportunities)
- Equipment and rental savings
- Schedule optimization (consolidating locations, grouping similar scenes)
- Location consolidation
- Night shoot reduction strategies` : ''}
${categories.includes('post') ? `POST-PRODUCTION optimizations:
- Post-production efficiencies
- VFX and editing optimization` : ''}` : `Analyze this budget and provide SPECIFIC, ACTIONABLE recommendations to MAXIMIZE PRODUCTION VALUE. For each recommendation:
1. Identify areas where the current budget is UNDER-ALLOCATED for production quality
2. Suggest strategic investments that would significantly improve the final product
3. Calculate the RECOMMENDED INVESTMENT for each area
4. Explain the expected quality/value improvement
5. Prioritize by impact on production quality

⚠️ IMPORTANT: ONLY analyze and provide recommendations for these SELECTED categories: [${categories.join(', ')}]
DO NOT include recommendations for categories not in this list.

${categories.includes('cast') ? `CAST & TALENT investments:
- Talent upgrades (better cast options, experienced actors)` : ''}
${categories.includes('crew') ? `CREW & EQUIPMENT investments:
- Production quality improvements (better equipment, additional shooting days)
- Technical improvements (camera packages, lighting, sound equipment)
- Location upgrades (better venues, additional locations)` : ''}
${categories.includes('post') ? `POST-PRODUCTION investments:
- Post-production enhancements (VFX, color grading, sound design)
- Creative additions (additional scenes, b-roll, reshoots buffer)` : ''}`}

Return your analysis in this JSON format.
⚠️ ONLY populate categories that match the selected focus areas [${categories.join(', ')}].
For non-selected categories, use empty recommendations array and 0 for savings/investment.

{
  "castOptimization": {
    "recommendations": ${categories.includes('cast') ? '["Specific cast recommendation 1", "Specific cast recommendation 2"]' : '[]'},
    "${isReduceCost ? 'estimatedSavings' : 'recommendedInvestment'}": ${categories.includes('cast') ? '48000' : '0'},
    "details": "${categories.includes('cast') ? '...' : 'Not analyzed - category not selected'}"
  },
  "crewOptimization": {
    "recommendations": ${categories.includes('crew') ? '["..."]' : '[]'},
    "${isReduceCost ? 'estimatedSavings' : 'recommendedInvestment'}": ${categories.includes('crew') ? '35000' : '0'},
    "details": "..."
  },
  "scheduleOptimization": {
    "recommendations": ${categories.includes('crew') ? '["..."]' : '[]'},
    "${isReduceCost ? 'estimatedSavings' : 'recommendedInvestment'}": ${categories.includes('crew') ? '72000' : '0'},
    "details": "..."
  },
  "locationConsolidation": {
    "recommendations": ${categories.includes('crew') ? '["..."]' : '[]'},
    "${isReduceCost ? 'estimatedSavings' : 'recommendedInvestment'}": ${categories.includes('crew') ? '15000' : '0'},
    "details": "..."
  },
  "equipmentSavings": {
    "recommendations": ${categories.includes('crew') ? '["..."]' : '[]'},
    "${isReduceCost ? 'estimatedSavings' : 'recommendedInvestment'}": ${categories.includes('crew') ? '10000' : '0'},
    "details": "..."
  },
  "postProduction": {
    "recommendations": ${categories.includes('post') ? '["..."]' : '[]'},
    "${isReduceCost ? 'estimatedSavings' : 'recommendedInvestment'}": ${categories.includes('post') ? '5000' : '0'},
    "details": "..."
  },
  "contingencyPlan": {
    "recommendations": ["${isReduceCost ? 'Risk mitigation strategies' : 'Quality assurance strategies'}"],
    "suggestedContingency": 50000,
    "details": "..."
  },
  "summary": {
    "${isReduceCost ? 'totalEstimatedSavings' : 'totalRecommendedInvestment'}": 185000,
    "${isReduceCost ? 'savingsPercentage' : 'investmentPercentage'}": 8.5,
    "implementationPriority": ["Only list categories that were analyzed"],
    "overallAssessment": "Brief assessment focusing ONLY on selected categories: [${categories.join(', ')}]"
  }
}

IMPORTANT: All JSON numeric fields (estimatedSavings, recommendedInvestment, suggestedContingency, totalEstimatedSavings, etc.) must be in WHOLE DOLLARS (not cents).
For example, $48,000 savings should be the number 48000, and $1,200,000 savings should be 1200000.
In recommendation TEXT and details, also express money in dollars with $ symbol (e.g., "$48,000 savings").
All text content MUST be in ${targetLanguage}.`;
}
