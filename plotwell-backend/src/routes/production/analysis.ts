import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { extractUserId, checkAIGenerationLimit, trackAIUsage, addPricingService, PricingRequest } from '../../middleware/pricingMiddleware';
import { ProductionAnalysisService } from '../../services/productionAnalysisService';
import { aiRouter, AIModelRouter } from '../../services/aiModelRouter';
import { getUserId, checkProjectAccessForUser, gatherProjectContext, supabase, SceneAnalysisSchema, BudgetOptimizeSchema, ShotListGenerateSchema, ScheduleOptimizeSchema } from './helpers';
import {
  SHOT_LIST_CONFIG,
  BUDGET_OPTIMIZATION_CONFIG,
  buildBudgetOptimizationSystem,
  buildShotListPrompt,
  buildBudgetOptimizationPrompt,
} from '../../prompts';

const router = Router();

// Enhanced AI-powered scene analysis that stores structured data
router.post('/analyze-script', requireAuth, async (req, res) => {
  try {
    const { projectId, scriptContent, projectType } = SceneAnalysisSchema.parse(req.body);

    const userId = getUserId(req);
    if (!userId) {
      console.error('No user ID found in request');
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot analyze scripts', role: access.role });
    }

    const result = await ProductionAnalysisService.analyzeScriptAndCreateCards(
      projectId,
      userId,
      scriptContent,
      projectType
    );

    res.json({
      success: true,
      analysis: result.analysis,
      sceneCards: result.sceneCards,
      budgetItems: result.budgetItems,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Script analysis error:', error);
    res.status(500).json({
      error: 'Script analysis failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// AI-powered shot list generation
router.post('/generate-shots', requireAuth, async (req, res) => {
  try {
    const { sceneHeading, sceneContent, characters, complexity } = ShotListGenerateSchema.parse(req.body);

    const shotListPrompt = buildShotListPrompt({
      sceneHeading,
      sceneContent,
      characters,
      complexity,
    });

    // Use AI router for shot list generation
    const shotListContext = AIModelRouter.createContext({
      requestType: 'generation',
      inputText: shotListPrompt,
      expectedOutputTokens: 1500,
      metadata: { forceModel: 'grok' }
    });

    const shotListResult = await aiRouter.executeCompletion(shotListContext, {
      messages: [
        { role: "user", content: shotListPrompt }
      ],
      maxTokens: 1500,
    });

    // Parse JSON array from AI response (may be wrapped in markdown code blocks)
    let shots: any[] = [];
    try {
      const raw = shotListResult.content || '';
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\[[\s\S]*\])/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
      const parsed = JSON.parse(jsonStr);
      shots = Array.isArray(parsed) ? parsed : (parsed.shots || []);
    } catch {
      console.error('❌ Failed to parse shot list JSON:', shotListResult.content?.substring(0, 200));
    }

    res.json({
      success: true,
      shots,
      sceneInfo: {
        heading: sceneHeading,
        characters,
        complexity
      }
    });

  } catch (error) {
    console.error('Shot list generation error:', error);
    res.status(500).json({
      error: 'Shot list generation failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// AI-powered budget optimization - Enhanced with comprehensive context
router.post('/optimize-budget', requireAuth, async (req, res) => {
  try {
    const {
      projectId,
      sceneCards: inputSceneCards,
      totalBudget: inputTotalBudget,
      language = 'en',
      goal = 'reduce_cost',
      targetPercentage = 15,
      categories: rawCategories
    } = BudgetOptimizeSchema.parse(req.body);

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot optimize budgets', role: access.role });
    }

    // Convert categories object to array if needed
    let categories: string[] = ['cast', 'crew', 'post'];
    if (rawCategories) {
      if (Array.isArray(rawCategories)) {
        categories = rawCategories;
      } else {
        // Convert object format {castTalent: true, crewEquipment: true} to array
        categories = [];
        if (rawCategories.castTalent) categories.push('cast');
        if (rawCategories.crewEquipment) categories.push('crew');
        if (rawCategories.postServices) categories.push('post');
      }
    }

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Gather comprehensive project context
    const context = await gatherProjectContext(projectId, userId);
    const { project, cast, crew, budgetItems, locations, sceneCards: dbSceneCards, metrics, sceneDescriptions } = context;

    // Use database scene cards if available, otherwise use input
    const sceneCards = dbSceneCards.length > 0 ? dbSceneCards : inputSceneCards;
    const totalBudget = metrics.totalBudget > 0 ? metrics.totalBudget : inputTotalBudget;

    // Map language codes to full language names
    const languageMap: Record<string, string> = {
      'en': 'English',
      'es': 'Spanish',
      'fr': 'French',
      'de': 'German',
      'it': 'Italian',
      'pt': 'Portuguese'
    };
    const targetLanguage = languageMap[language] || 'English';

    // Determine project scale based on budget
    let projectScale = 'micro';
    if (totalBudget > 100000000) projectScale = 'studio';      // >$1M
    else if (totalBudget > 20000000) projectScale = 'moderate'; // >$200K
    else if (totalBudget > 5000000) projectScale = 'low';       // >$50K

    // Calculate budget percentages for analysis
    const aboveTheLinePercent = totalBudget > 0 ? Math.round((metrics.aboveTheLineBudget / totalBudget) * 100) : 0;
    const belowTheLinePercent = totalBudget > 0 ? Math.round((metrics.belowTheLineBudget / totalBudget) * 100) : 0;

    // Group budget items by category for clearer presentation
    const budgetByCategory: Record<string, { items: any[], total: number }> = {};
    (budgetItems || []).forEach(item => {
      const cat = item.category_name || 'Other';
      if (!budgetByCategory[cat]) {
        budgetByCategory[cat] = { items: [], total: 0 };
      }
      budgetByCategory[cat].items.push(item);
      budgetByCategory[cat].total += item.total || 0;
    });

    // Calculate target savings/increase amount
    const targetAmount = Math.round(totalBudget * (targetPercentage / 100));

    const isReduceCost = goal === 'reduce_cost';
    const goalDescription = isReduceCost
      ? `REDUCE COSTS by ${targetPercentage}% (target: $${(targetAmount / 100).toLocaleString()} savings)`
      : `MAXIMIZE VALUE within current budget OR identify areas where ${targetPercentage}% additional investment would significantly improve production quality`;

    const budgetPrompt = buildBudgetOptimizationPrompt({
      targetLanguage,
      goalDescription,
      categories,
      isReduceCost,
      targetPercentage,
      targetAmount,
      project,
      projectScale,
      totalBudget,
      metrics,
      aboveTheLinePercent,
      belowTheLinePercent,
      budgetByCategory,
      sceneCards,
      sceneDescriptions,
      cast,
      crew,
      locations,
    });


    // Create routing context for AI model selection
    const routingContext = AIModelRouter.createContext({
      requestType: 'extraction',
      inputText: budgetPrompt,
      expectedOutputTokens: 6000,
      metadata: {
        contentScale: projectScale === 'studio' ? 'feature' : 'standard'
      }
    });

    const response = await aiRouter.executeCompletion(routingContext, {
      messages: [
        {
          role: 'system',
          content: buildBudgetOptimizationSystem(isReduceCost, targetLanguage)
        },
        {
          role: 'user',
          content: budgetPrompt
        }
      ],
      maxTokens: 6000,
      temperature: 0.4  // Lower temperature for more consistent, factual analysis
    });

    const aiResponse = response.content;
    if (!aiResponse) {
      throw new Error('No response from AI');
    }

    // Parse AI response
    let optimizations;
    try {
      const cleanedResponse = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      optimizations = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error('Failed to parse AI response:', aiResponse);
      throw new Error('Invalid AI response format');
    }

    // Convert AI dollar values to cents for frontend compatibility
    const dollarFields = ['estimatedSavings', 'recommendedInvestment', 'suggestedContingency'];
    for (const [key, value] of Object.entries(optimizations)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const category = value as Record<string, any>;
        for (const field of dollarFields) {
          if (typeof category[field] === 'number') {
            category[field] = Math.round(category[field] * 100);
          }
        }
      }
    }
    if (optimizations.summary) {
      const summaryFields = ['totalEstimatedSavings', 'totalRecommendedInvestment'];
      for (const field of summaryFields) {
        if (typeof optimizations.summary[field] === 'number') {
          optimizations.summary[field] = Math.round(optimizations.summary[field] * 100);
        }
      }
    }

    // Store optimization results with full context
    const { error: insertError } = await supabase
      .from('production_analyses')
      .insert({
        project_id: projectId,
        user_id: userId,
        analysis_type: 'budget_optimization',
        content: JSON.stringify({
          scenes: sceneCards.length,
          cast: cast.length,
          crew: crew.length,
          totalBudget,
          metrics,
          projectScale
        }),
        ai_response: JSON.stringify(optimizations)
      });

    if (insertError) {
      console.error('Failed to store optimization results:', insertError);
    }

    res.json({
      success: true,
      message: 'Budget optimization complete',
      projectId,
      optimizations,
      originalBudget: totalBudget,
      sceneCount: sceneCards.length,
      metrics,
      analysisDate: new Date().toISOString()
    });

  } catch (error) {
    console.error('Budget optimization error:', error);
    res.status(500).json({
      error: 'Budget optimization failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// AI-powered budget scenarios (Conservative, Moderate, Aggressive) - Enhanced
router.post('/budget-scenarios', requireAuth, async (req, res) => {
  try {
    const { projectId, sceneCards: inputSceneCards, totalBudget: inputTotalBudget, language = 'en' } = req.body;

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot generate budget scenarios', role: access.role });
    }

    // Gather comprehensive project context
    const context = await gatherProjectContext(projectId, userId);
    const { project, cast, crew, budgetItems, locations, sceneCards: dbSceneCards, metrics, sceneDescriptions } = context;

    // Use database data if available
    const sceneCards = dbSceneCards.length > 0 ? dbSceneCards : (inputSceneCards || []);
    const totalBudget = metrics.totalBudget > 0 ? metrics.totalBudget : inputTotalBudget;

    // Map language codes to full language names
    const languageMap: Record<string, string> = {
      'en': 'English',
      'es': 'Spanish',
      'fr': 'French',
      'de': 'German',
      'it': 'Italian',
      'pt': 'Portuguese'
    };
    const targetLanguage = languageMap[language] || 'English';

    // Determine project scale
    let projectScale = 'micro';
    if (totalBudget > 100000000) projectScale = 'studio';
    else if (totalBudget > 20000000) projectScale = 'moderate';
    else if (totalBudget > 5000000) projectScale = 'low';

    // Calculate realistic savings targets based on budget
    // Pre-calculate savings targets in DOLLARS for the AI prompt
    const totalBudgetDollars = Math.round(totalBudget / 100);
    const conservativeSavings = Math.round(totalBudgetDollars * 0.07);  // 5-10%
    const moderateSavings = Math.round(totalBudgetDollars * 0.17);      // 15-20%
    const aggressiveSavings = Math.round(totalBudgetDollars * 0.27);    // 25-30%

    // Group budget by category for analysis
    const budgetByCategory: Record<string, number> = {};
    (budgetItems || []).forEach(item => {
      const cat = item.category_name || 'Other';
      budgetByCategory[cat] = (budgetByCategory[cat] || 0) + (item.total || 0);
    });

    // Find largest budget categories (most potential for savings)
    const sortedCategories = Object.entries(budgetByCategory)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5);

    const scenariosPrompt = `You are an expert film Line Producer creating budget reduction scenarios for a production company. Generate THREE realistic budget optimization scenarios based on actual industry practices.

IMPORTANT: All text MUST be in ${targetLanguage}. JSON keys stay in English.

═══════════════════════════════════════════════════════════════════
PROJECT ANALYSIS
═══════════════════════════════════════════════════════════════════
Project: ${project?.name || 'Untitled'}
Type: ${project?.project_type || 'film'}
Scale: ${projectScale} budget
Location: ${project?.production_country || 'Not specified'}

CURRENT BUDGET: $${totalBudgetDollars.toLocaleString()}
Shoot Days: ${metrics.totalShootDays}
Cost/Day: $${(metrics.costPerShootDay / 100).toLocaleString()}

BUDGET DISTRIBUTION:
${sortedCategories.map(([cat, amount]) => {
  const percent = Math.round((amount / totalBudget) * 100);
  return `- ${cat}: $${(amount / 100).toLocaleString()} (${percent}%)`;
}).join('\n')}

SCENES: ${sceneCards.length} total
- Simple: ${metrics.complexityCount.simple}
- Medium: ${metrics.complexityCount.medium}
- Complex: ${metrics.complexityCount.complex}
- Night shoots: ${metrics.timeOfDayCount.night} (expensive)

CAST: ${cast.length} members - Est. Total: $${(metrics.castTotalCost / 100).toLocaleString()}
${cast.slice(0, 5).map(c => `- ${c.character_name} (${c.category}): $${((c.rate_per_day || 0) / 100).toLocaleString()}/day`).join('\n')}

CREW: ${crew.length} members - Est. Total: $${(metrics.crewTotalCost / 100).toLocaleString()}
${crew.slice(0, 5).map(c => `- ${c.role} (${c.department}): $${((c.rate_per_day || 0) / 100).toLocaleString()}/day`).join('\n')}

LOCATIONS: ${locations.length}
${locations.slice(0, 3).map(loc => `- ${loc.name}: $${((loc.estimated_cost || 0) / 100).toLocaleString()}`).join('\n')}

═══════════════════════════════════════════════════════════════════
SCENARIO REQUIREMENTS
═══════════════════════════════════════════════════════════════════
Create THREE scenarios with SPECIFIC, ACTIONABLE cuts. Each recommendation must:
1. Reference ACTUAL items from the budget above
2. Calculate REAL savings (not made-up numbers)
3. Explain what gets cut or changed
4. Note the impact on production quality

CONSERVATIVE (5-10% savings, ~$${conservativeSavings.toLocaleString()}):
- Minor adjustments that don't affect creative vision
- Schedule optimization, equipment rental negotiations
- Minimal impact on quality

MODERATE (15-20% savings, ~$${moderateSavings.toLocaleString()}):
- Significant but manageable changes
- Crew reduction, location consolidation, some scope reduction
- Some creative compromises required

AGGRESSIVE (25-30% savings, ~$${aggressiveSavings.toLocaleString()}):
- Major restructuring of the production
- Significant crew/cast cuts, multiple locations dropped
- Substantial creative impact

Return JSON in this EXACT format:
{
  "conservative": {
    "target_percentage": "5-10%",
    "recommendations": [
      "SPECIFIC recommendation with exact savings amount",
      "Another specific recommendation"
    ],
    "estimated_savings": ${conservativeSavings},
    "risk_level": "Low",
    "quality_impact": "Minimal - maintains creative vision",
    "description": "Brief overview of conservative approach",
    "cuts_by_category": {
      "Equipment": 20000,
      "Schedule": 30000
    }
  },
  "moderate": {
    "target_percentage": "15-20%",
    "recommendations": ["..."],
    "estimated_savings": ${moderateSavings},
    "risk_level": "Medium",
    "quality_impact": "Noticeable - some compromises needed",
    "description": "...",
    "cuts_by_category": {}
  },
  "aggressive": {
    "target_percentage": "25-30%",
    "recommendations": ["..."],
    "estimated_savings": ${aggressiveSavings},
    "risk_level": "High",
    "quality_impact": "Significant - major creative changes",
    "description": "...",
    "cuts_by_category": {}
  }
}

IMPORTANT: All JSON numeric fields (estimated_savings, cuts_by_category values) must be in WHOLE DOLLARS (not cents).
For example, $48,000 savings should be the number 48000, and $1,200,000 savings should be 1200000.
In recommendation TEXT, also express money in dollars with $ symbol (e.g., "$48,000 savings").
All text in ${targetLanguage}.`;

    // Create routing context for AI model selection
    const scenariosRoutingContext = AIModelRouter.createContext({
      requestType: 'extraction',
      inputText: scenariosPrompt,
      expectedOutputTokens: 5000,
      metadata: {
        contentScale: projectScale === 'studio' ? 'feature' : 'standard'
      }
    });

    const response = await aiRouter.executeCompletion(scenariosRoutingContext, {
      messages: [
        {
          role: 'system',
          content: `You are an expert Line Producer creating budget scenarios. Output valid JSON only, no markdown. All monetary values in WHOLE DOLLARS (not cents). All text in ${targetLanguage}.`
        },
        {
          role: 'user',
          content: scenariosPrompt
        }
      ],
      maxTokens: 5000,
      temperature: 0.4
    });

    const aiResponse = response.content;
    if (!aiResponse) {
      throw new Error('No response from AI');
    }

    let scenarios;
    try {
      const cleanedResponse = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      scenarios = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error('Failed to parse AI response:', aiResponse);
      throw new Error('Invalid AI response format');
    }

    // Convert AI dollar values to cents for frontend compatibility
    for (const [, scenario] of Object.entries(scenarios)) {
      if (scenario && typeof scenario === 'object') {
        const s = scenario as Record<string, any>;
        if (typeof s.estimated_savings === 'number') {
          s.estimated_savings = Math.round(s.estimated_savings * 100);
        }
        if (s.cuts_by_category && typeof s.cuts_by_category === 'object') {
          for (const [cat, val] of Object.entries(s.cuts_by_category)) {
            if (typeof val === 'number') {
              s.cuts_by_category[cat] = Math.round(val * 100);
            }
          }
        }
      }
    }

    // Store scenarios results with context
    const { error: insertError } = await supabase
      .from('production_analyses')
      .insert({
        project_id: projectId,
        user_id: userId,
        analysis_type: 'budget_scenarios',
        content: JSON.stringify({
          scenes: sceneCards.length,
          cast: cast.length,
          crew: crew.length,
          totalBudget,
          metrics,
          projectScale
        }),
        ai_response: JSON.stringify(scenarios)
      });

    if (insertError) {
      console.error('Failed to store scenarios results:', insertError);
    }

    res.json({
      scenarios,
      context: {
        totalBudget,
        sceneCount: sceneCards.length,
        projectScale,
        metrics
      }
    });

  } catch (error) {
    console.error('Budget scenarios error:', error);
    res.status(500).json({
      error: 'Budget scenarios generation failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// AI-powered budget health analysis - Enhanced with comprehensive metrics
router.post('/budget-health', requireAuth, async (req, res) => {
  try {
    const { projectId, sceneCards: inputSceneCards, totalBudget: inputTotalBudget, language = 'en' } = req.body;

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot analyze budget health', role: access.role });
    }

    // Gather comprehensive project context
    const context = await gatherProjectContext(projectId, userId);
    const { project, cast, crew, budgetItems, locations, sceneCards: dbSceneCards, metrics } = context;

    // Use database data if available
    const sceneCards = dbSceneCards.length > 0 ? dbSceneCards : (inputSceneCards || []);
    const totalBudget = metrics.totalBudget > 0 ? metrics.totalBudget : inputTotalBudget;

    // Map language codes to full language names
    const languageMap: Record<string, string> = {
      'en': 'English',
      'es': 'Spanish',
      'fr': 'French',
      'de': 'German',
      'it': 'Italian',
      'pt': 'Portuguese'
    };
    const targetLanguage = languageMap[language] || 'English';

    // Determine project scale
    let projectScale = 'micro';
    if (totalBudget > 100000000) projectScale = 'studio';
    else if (totalBudget > 20000000) projectScale = 'moderate';
    else if (totalBudget > 5000000) projectScale = 'low';

    // Calculate budget distribution percentages
    const aboveTheLinePercent = totalBudget > 0 ? Math.round((metrics.aboveTheLineBudget / totalBudget) * 100) : 0;
    const belowTheLinePercent = totalBudget > 0 ? Math.round((metrics.belowTheLineBudget / totalBudget) * 100) : 0;

    // Group budget by category
    const budgetByCategory: Record<string, { total: number, items: any[] }> = {};
    (budgetItems || []).forEach(item => {
      const cat = item.category_name || 'Other';
      if (!budgetByCategory[cat]) {
        budgetByCategory[cat] = { total: 0, items: [] };
      }
      budgetByCategory[cat].total += item.total || 0;
      budgetByCategory[cat].items.push(item);
    });

    // Calculate pre-analysis health indicators
    const hasContingency = Object.keys(budgetByCategory).some(cat =>
      cat.toLowerCase().includes('contingency') || cat.toLowerCase().includes('reserve')
    );
    const contingencyAmount = hasContingency
      ? Object.entries(budgetByCategory)
          .filter(([cat]) => cat.toLowerCase().includes('contingency') || cat.toLowerCase().includes('reserve'))
          .reduce((sum, [, data]) => sum + data.total, 0)
      : 0;
    const contingencyPercent = totalBudget > 0 ? Math.round((contingencyAmount / totalBudget) * 100) : 0;

    // Calculate crew completeness
    const essentialRoles = ['Director', 'DP', 'Director of Photography', 'Sound', 'Production Manager', 'Producer'];
    const hasEssentialCrew = essentialRoles.filter(role =>
      crew.some(c => c.role?.toLowerCase().includes(role.toLowerCase()))
    ).length;
    const crewCompleteness = Math.round((hasEssentialCrew / essentialRoles.length) * 100);

    // Check for common budget issues
    const issues: string[] = [];
    if (contingencyPercent < 5) issues.push('Missing or insufficient contingency fund');
    if (metrics.timeOfDayCount.night > metrics.timeOfDayCount.day * 0.5) issues.push('High ratio of night shoots');
    if (metrics.complexityCount.complex > sceneCards.length * 0.3) issues.push('Many complex scenes');
    if (aboveTheLinePercent > 45) issues.push('Above-the-line costs exceed 45%');
    if (crewCompleteness < 50) issues.push('Missing essential crew positions');

    const healthPrompt = `You are an expert film production Line Producer conducting a comprehensive budget health assessment. Analyze this production budget against industry standards and provide a detailed health report.

IMPORTANT: All text MUST be in ${targetLanguage}. JSON keys stay in English.

═══════════════════════════════════════════════════════════════════
PROJECT OVERVIEW
═══════════════════════════════════════════════════════════════════
Project: ${project?.name || 'Untitled'}
Type: ${project?.project_type || 'film'}
Scale: ${projectScale} budget
Location: ${project?.production_country || 'Not specified'}

TOTAL BUDGET: $${(totalBudget / 100).toLocaleString()}

═══════════════════════════════════════════════════════════════════
KEY METRICS
═══════════════════════════════════════════════════════════════════
Total Shoot Days: ${metrics.totalShootDays}
Cost Per Shoot Day: $${(metrics.costPerShootDay / 100).toLocaleString()}
Average Cost Per Scene: $${(metrics.averageSceneBudget / 100).toLocaleString()}
Number of Scenes: ${sceneCards.length}

BUDGET DISTRIBUTION:
- Above-the-Line: $${(metrics.aboveTheLineBudget / 100).toLocaleString()} (${aboveTheLinePercent}%)
  Industry benchmark: 15-40%
  ${aboveTheLinePercent > 40 ? '⚠️ HIGH' : aboveTheLinePercent < 15 ? '✓ LEAN' : '✓ NORMAL'}

- Below-the-Line: $${(metrics.belowTheLineBudget / 100).toLocaleString()} (${belowTheLinePercent}%)

- Contingency: $${(contingencyAmount / 100).toLocaleString()} (${contingencyPercent}%)
  Industry benchmark: 10-15%
  ${contingencyPercent < 5 ? '⚠️ CRITICAL - Too low!' : contingencyPercent < 10 ? '⚠️ LOW' : '✓ ADEQUATE'}

BUDGET BY CATEGORY:
${Object.entries(budgetByCategory)
  .sort(([,a], [,b]) => b.total - a.total)
  .map(([cat, data]) => {
    const percent = totalBudget > 0 ? Math.round((data.total / totalBudget) * 100) : 0;
    return `${cat}: $${(data.total / 100).toLocaleString()} (${percent}%)`;
  }).join('\n')}

═══════════════════════════════════════════════════════════════════
SCENE COMPLEXITY ANALYSIS
═══════════════════════════════════════════════════════════════════
- Simple scenes: ${metrics.complexityCount.simple} (${Math.round((metrics.complexityCount.simple / Math.max(sceneCards.length, 1)) * 100)}%)
- Medium scenes: ${metrics.complexityCount.medium} (${Math.round((metrics.complexityCount.medium / Math.max(sceneCards.length, 1)) * 100)}%)
- Complex scenes: ${metrics.complexityCount.complex} (${Math.round((metrics.complexityCount.complex / Math.max(sceneCards.length, 1)) * 100)}%)

TIME OF DAY:
- Day scenes: ${metrics.timeOfDayCount.day}
- Night scenes: ${metrics.timeOfDayCount.night} (typically 20-30% more expensive)
- Dawn/Dusk: ${metrics.timeOfDayCount.dawn + metrics.timeOfDayCount.dusk}

═══════════════════════════════════════════════════════════════════
CAST & CREW ANALYSIS
═══════════════════════════════════════════════════════════════════
CAST: ${cast.length} members
Total Est. Cast Cost: $${(metrics.castTotalCost / 100).toLocaleString()}
${cast.slice(0, 5).map(c => `- ${c.character_name} (${c.category}): $${((c.rate_per_day || 0) / 100).toLocaleString()}/day`).join('\n')}

CREW: ${crew.length} members
Total Est. Crew Cost: $${(metrics.crewTotalCost / 100).toLocaleString()}
Crew Completeness: ${crewCompleteness}% (essential positions filled)
${crew.slice(0, 5).map(c => `- ${c.role} (${c.department}): $${((c.rate_per_day || 0) / 100).toLocaleString()}/day`).join('\n')}

═══════════════════════════════════════════════════════════════════
LOCATIONS: ${locations.length}
═══════════════════════════════════════════════════════════════════
${locations.map(loc => `- ${loc.name} (${loc.location_type}): $${((loc.estimated_cost || 0) / 100).toLocaleString()}`).join('\n') || 'No locations defined'}

═══════════════════════════════════════════════════════════════════
PRE-IDENTIFIED ISSUES
═══════════════════════════════════════════════════════════════════
${issues.length > 0 ? issues.map(i => `⚠️ ${i}`).join('\n') : '✓ No critical issues detected'}

═══════════════════════════════════════════════════════════════════
ANALYSIS INSTRUCTIONS
═══════════════════════════════════════════════════════════════════
Provide a comprehensive health assessment with:

1. HEALTH SCORE (0-100) based on:
   - Budget distribution balance (25 points)
   - Contingency adequacy (20 points)
   - Crew/cast completeness (15 points)
   - Schedule feasibility (15 points)
   - Risk management (15 points)
   - Overall budget efficiency (10 points)

2. SPECIFIC INSIGHTS referencing actual budget items and numbers

3. CONCRETE RISKS with severity levels

4. ACTIONABLE RECOMMENDATIONS with priority

Return JSON in this format:
{
  "health_score": 75,
  "status": "Fair",
  "grade": "C+",
  "summary": "One-paragraph executive summary of budget health",
  "score_breakdown": {
    "budget_distribution": 20,
    "contingency": 10,
    "crew_completeness": 12,
    "schedule_feasibility": 13,
    "risk_management": 10,
    "efficiency": 10
  },
  "insights": [
    "Specific positive finding with numbers",
    "Another specific insight"
  ],
  "risks": [
    {
      "severity": "high",
      "description": "Specific risk description",
      "impact": "Potential impact in dollars or percentage"
    }
  ],
  "recommendations": [
    {
      "priority": "high",
      "action": "Specific action to take",
      "expected_benefit": "What this will achieve"
    }
  ],
  "industry_comparison": {
    "cost_per_day_assessment": "How cost/day compares to industry",
    "budget_distribution_assessment": "How distribution compares",
    "overall_position": "Where this budget sits vs similar productions"
  }
}

All text in ${targetLanguage}. Be specific - reference actual numbers from the data above.
When mentioning money in text (insights, risks, recommendations), always use DOLLARS with $ symbol (e.g., "$10,300" NOT "1,030,000 cents").`;

    // Create routing context for AI model selection
    const healthRoutingContext = AIModelRouter.createContext({
      requestType: 'extraction',
      inputText: healthPrompt,
      expectedOutputTokens: 5000,
      metadata: {
        contentScale: projectScale === 'studio' ? 'feature' : 'standard'
      }
    });

    const response = await aiRouter.executeCompletion(healthRoutingContext, {
      messages: [
        {
          role: 'system',
          content: `You are an expert Line Producer providing budget health assessments. Be specific and reference actual data. Output valid JSON only. All text in ${targetLanguage}.`
        },
        {
          role: 'user',
          content: healthPrompt
        }
      ],
      maxTokens: 5000,
      temperature: 0.3  // Low temperature for consistent, analytical output
    });

    const aiResponse = response.content;
    if (!aiResponse) {
      throw new Error('No response from AI');
    }

    let healthAnalysis;
    try {
      const cleanedResponse = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      healthAnalysis = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error('Failed to parse AI response:', aiResponse);
      throw new Error('Invalid AI response format');
    }

    // Store health analysis results with full context
    const { error: insertError } = await supabase
      .from('production_analyses')
      .insert({
        project_id: projectId,
        user_id: userId,
        analysis_type: 'budget_health',
        content: JSON.stringify({
          scenes: sceneCards.length,
          cast: cast.length,
          crew: crew.length,
          totalBudget,
          metrics,
          projectScale,
          preIdentifiedIssues: issues
        }),
        ai_response: JSON.stringify(healthAnalysis)
      });

    if (insertError) {
      console.error('Failed to store health analysis results:', insertError);
    }

    res.json({
      ...healthAnalysis,
      context: {
        totalBudget,
        sceneCount: sceneCards.length,
        projectScale,
        metrics,
        preIdentifiedIssues: issues
      }
    });

  } catch (error) {
    console.error('Budget health analysis error:', error);
    res.status(500).json({
      error: 'Budget health analysis failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// AI-powered schedule optimization
router.post('/optimize-schedule', requireAuth, async (req, res) => {
  try {
    const { projectId, scenes } = ScheduleOptimizeSchema.parse(req.body);

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access with edit permission
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot optimize schedules', role: access.role });
    }

    const schedulePrompt = `
Optimize the shooting schedule for this production:

SCENES TO SCHEDULE: ${scenes.length}

SCENE DETAILS:
${scenes.map(scene => `
Scene ${scene.number}
- Location: ${scene.location}
- Time of Day: ${scene.timeOfDay}
- Characters: ${scene.characters.join(', ')}
- Estimated Days: ${scene.estimatedShootDays}
`).join('\n')}

Please provide:
1. Optimal shooting order based on location grouping
2. Day/night scheduling efficiency
3. Cast availability optimization
4. Equipment sharing opportunities
5. Location-based scheduling blocks
6. Weather/seasonal considerations
7. Crew efficiency maximization
8. Potential scheduling conflicts and solutions
9. Recommended shooting days breakdown
10. Contingency planning suggestions

Return a detailed shooting schedule with reasoning for each decision.
`;

    // Use AI router for schedule optimization
    const scheduleContext = AIModelRouter.createContext({
      requestType: 'generation',
      inputText: schedulePrompt,
      expectedOutputTokens: 2000,
      metadata: { forceModel: 'grok' }
    });

    const scheduleResult = await aiRouter.executeCompletion(scheduleContext, {
      messages: [
        { role: 'user', content: schedulePrompt }
      ],
      maxTokens: 2000,
    });

    const aiResult = scheduleResult.content;

    // Store schedule optimization results
    const { error: insertError } = await supabase
      .from('production_analyses')
      .insert({
        project_id: projectId,
        user_id: getUserId(req),
        analysis_type: 'schedule_optimization',
        content: JSON.stringify({ scenes }),
        ai_response: aiResult
      });

    res.json({
      success: true,
      schedule: aiResult,
      sceneCount: scenes.length,
      totalDays: scenes.reduce((sum, scene) => sum + scene.estimatedShootDays, 0)
    });

  } catch (error) {
    console.error('Schedule optimization error:', error);
    res.status(500).json({
      error: 'Schedule optimization failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get production history
router.get('/history/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;

    const { data, error } = await supabase
      .from('production_analyses')
      .select('analysis_type, ai_response, created_at')
      .eq('project_id', projectId)
      .eq('user_id', getUserId(req))
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      history: data
    });

  } catch (error) {
    console.error('Production history error:', error);
    res.status(500).json({
      error: 'Failed to fetch production history',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Location scouting suggestions
router.post('/suggest-locations', requireAuth, async (req, res) => {
  try {
    const { locations, budget, region } = req.body;

    const locationPrompt = `
Provide location scouting suggestions for this production:

REQUIRED LOCATIONS:
${locations.map((loc: any) => `- ${loc.name} (${loc.type}) - ${loc.scenes.length} scenes`).join('\n')}

BUDGET: $${budget?.toLocaleString() || 'Not specified'}
REGION: ${region || 'Not specified'}

Please suggest:
1. Specific location types and venues
2. Cost-effective alternatives
3. Multi-use locations that could serve multiple scenes
4. Permits and legal considerations
5. Accessibility and logistics factors
6. Backup location options
7. Green screen vs practical location analysis
8. Local film commission resources

Provide practical, actionable location suggestions with estimated costs.
`;

    // Use AI router for location suggestions
    const locationContext = AIModelRouter.createContext({
      requestType: 'generation',
      inputText: locationPrompt,
      expectedOutputTokens: 1500,
      metadata: { forceModel: 'grok' }
    });

    const locationResult = await aiRouter.executeCompletion(locationContext, {
      messages: [
        { role: 'user', content: locationPrompt }
      ],
      maxTokens: 1500,
    });

    const aiResult = locationResult.content;

    res.json({
      success: true,
      suggestions: aiResult,
      requestedLocations: locations.length
    });

  } catch (error) {
    console.error('Location suggestions error:', error);
    res.status(500).json({
      error: 'Location suggestions failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Fill production module with AI-generated data
 */
router.post('/fill-with-ai', requireAuth, extractUserId, addPricingService, checkAIGenerationLimit, trackAIUsage, async (req: PricingRequest, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated properly' });
    }

    const {
      project_id,
      episode_id, // Optional episode ID for TV series
      project_type = 'film',
      script,
      storyboard,
      characters,
      locations,
      documents,
      generate_only, // 'cast', 'crew', 'budget', or undefined for all
      include_contexts // Optional: { characters, locations, documents } to control what context to send
    } = req.body;

    if (!project_id) {
      return res.status(400).json({ error: 'Project ID is required' });
    }

    // Load project settings (language, location, etc.)
    const { data: projectData, error: projectError } = await supabase
      .from('projects')
      .select('language, content_language')
      .eq('id', project_id)
      .eq('user_id', userId)
      .single();

    if (projectError) {
      console.error('Failed to load project settings:', projectError);
      // Continue without language settings if they fail to load
    }

    const projectSettings = {
      language: projectData?.language || 'en',
      content_language: projectData?.content_language || 'en'
    };

    // Filter context based on include_contexts (if provided)
    const filteredCharacters = include_contexts?.characters === false ? undefined : characters;
    const filteredLocations = include_contexts?.locations === false ? undefined : locations;
    const filteredDocuments = include_contexts?.documents === false ? undefined : documents;

    // Use ProductionAnalysisService to analyze all project data and generate comprehensive results
    const result = await ProductionAnalysisService.analyzeProjectAndFillProduction(
      project_id,
      userId,
      {
        script,
        storyboard: undefined, // Storyboard panels not useful for production analysis
        characters: filteredCharacters,
        locations: filteredLocations,
        documents: filteredDocuments,
        projectType: project_type,
        generateOnly: generate_only, // Pass the parameter to the service
        episodeId: episode_id // Pass episode_id for TV series context
      },
      projectSettings
    );

    res.json({
      success: true,
      message: 'Production data generated successfully',
      ...result
    });

  } catch (error) {
    console.error('Error in fill-with-ai endpoint:', error);
    res.status(500).json({
      error: 'Failed to generate production data',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get analysis history for a project
 * GET /api/production/analysis-history/:projectId
 */
router.get('/analysis-history/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify project access (owner OR collaborator)
    const access = await checkProjectAccessForUser(projectId, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Fetch analysis history from production_analyses table
    // Show all analyses for the project (not filtered by user_id for collaboration)
    const { data: analyses, error } = await supabase
      .from('production_analyses')
      .select('*')
      .eq('project_id', projectId)
      .in('analysis_type', ['budget_optimization', 'budget_scenarios', 'budget_health', 'schedule_optimization', 'logistics_optimization'])
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Error fetching analysis history:', error);
      return res.status(500).json({ error: 'Failed to fetch analysis history' });
    }

    // Filter out analyses with empty ai_response
    const validAnalyses = (analyses || []).filter(analysis =>
      analysis.ai_response && analysis.ai_response.trim().length > 0
    );

    res.json({
      success: true,
      analyses: validAnalyses
    });
  } catch (error) {
    console.error('Error fetching analysis history:', error);
    res.status(500).json({
      error: 'Failed to fetch analysis history',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Delete an analysis
 * DELETE /api/production/analysis/:analysisId
 */
router.delete('/analysis/:analysisId', requireAuth, async (req, res) => {
  try {
    const { analysisId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get analysis to find project_id
    const { data: analysis, error: fetchError } = await supabase
      .from('production_analyses')
      .select('project_id')
      .eq('id', analysisId)
      .single();

    if (fetchError || !analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }

    // Verify project access and edit permission
    const access = await checkProjectAccessForUser(analysis.project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Viewers cannot delete analyses' });
    }

    // Delete the analysis
    const { error } = await supabase
      .from('production_analyses')
      .delete()
      .eq('id', analysisId);

    if (error) {
      console.error('Error deleting analysis:', error);
      return res.status(500).json({ error: 'Failed to delete analysis' });
    }

    res.json({
      success: true,
      message: 'Analysis deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting analysis:', error);
    res.status(500).json({
      error: 'Failed to delete analysis',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
