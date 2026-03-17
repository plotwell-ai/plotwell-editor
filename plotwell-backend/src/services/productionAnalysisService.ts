import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import { extractTextFromTipTapJSON, extractJsonFromAIResponseWithRepair } from '../utils/aiHelpers';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 10 * 60 * 1000, // 10 minutes timeout for production analysis
});

export interface SceneCard {
  scene_number: number;
  heading: string;
  location: string;
  time_of_day: 'day' | 'night' | 'dawn' | 'dusk';
  complexity: 'simple' | 'medium' | 'complex';
  characters: string[];
  estimated_shoot_days: number;
  budget: number;
  notes?: string;
}

export interface BudgetItem {
  category_name: string;
  item_name: string;
  quantity: number;
  rate: number;
  unit: string;
  total: number;
  notes?: string;
}

export interface ScheduleItem {
  scene_id: string;
  shoot_date: string;
  start_time: string;
  end_time: string;
  location: string;
  crew_requirements: any;
  equipment_requirements: string[];
  notes?: string;
}

export class ProductionAnalysisService {
  static async analyzeScriptAndCreateCards(
    projectId: string,
    userId: string,
    scriptContent: string,
    projectType: string = 'film'
  ): Promise<{
    analysis: string;
    sceneCards: SceneCard[];
    budgetItems: BudgetItem[];
  }> {
    // Enhanced AI prompt for structured analysis
    const analysisPrompt = `
You are an expert film production manager. Analyze this ${projectType} script and provide:

1. A comprehensive production analysis
2. Structured scene breakdown data
3. Detailed budget breakdown

SCRIPT CONTENT:
${scriptContent}

Return your response in this JSON format:
{
  "analysis": "Your detailed production analysis text here...",
  "scenes": [
    {
      "scene_number": 1,
      "heading": "INT. APARTMENT - DAY",
      "location": "Apartment Living Room",
      "time_of_day": "day",
      "complexity": "simple",
      "characters": ["JOHN", "MARY"],
      "estimated_shoot_days": 0.5,
      "budget": 5000,
      "notes": "Basic dialogue scene, minimal setup required"
    }
  ],
  "budget_items": [
    {
      "category_name": "Cast",
      "item_name": "Lead Actor Day Rate",
      "quantity": 5,
      "rate": 100000,
      "unit": "day",
      "total": 500000,
      "notes": "5 shooting days"
    },
    {
      "category_name": "Location",
      "item_name": "Apartment Rental",
      "quantity": 2,
      "rate": 50000,
      "unit": "day",
      "total": 100000,
      "notes": "Interior apartment scenes"
    }
  ]
}

Important notes:
- Budget amounts should be in cents (multiply by 100)
- complexity should be: "simple", "medium", or "complex"  
- time_of_day should be: "day", "night", "dawn", or "dusk"
- Include realistic budget items for cast, crew, locations, equipment, catering, etc.
- Estimate shooting days based on page count and scene complexity
`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a film production manager. Return only valid JSON in the exact format requested. Be direct and concise. Start immediately with JSON - no explanations.'
          },
          {
            role: 'user',
            content: analysisPrompt
          }
        ],
        max_completion_tokens: 24000
      });

      const aiResponse = completion.choices[0].message.content!;
      let structuredData;

      const extractionResult = extractJsonFromAIResponseWithRepair(aiResponse);
      if (extractionResult.success && extractionResult.json) {
        structuredData = extractionResult.json;
      } else {
        console.error('Failed to parse AI response as JSON:', extractionResult.error);
        // Fallback: store just the analysis text
        structuredData = {
          analysis: aiResponse,
          scenes: [],
          budget_items: []
        };
      }

      // Store the analysis
      const { data: analysisData, error: analysisError } = await supabase
        .from('production_analyses')
        .insert({
          project_id: projectId,
          user_id: userId,
          analysis_type: 'script_analysis',
          content: scriptContent,
          ai_response: structuredData.analysis || aiResponse
        })
        .select()
        .single();

      if (analysisError) throw analysisError;

      // Store scene cards if we have them
      const sceneCards: SceneCard[] = [];
      if (structuredData.scenes && structuredData.scenes.length > 0) {
        const sceneCardsToInsert = structuredData.scenes.map((scene: any) => ({
          project_id: projectId,
          user_id: userId,
          scene_number: scene.scene_number,
          heading: scene.heading,
          location: scene.location || '',
          time_of_day: scene.time_of_day || 'day',
          complexity: scene.complexity || 'medium',
          characters: scene.characters || [],
          estimated_shoot_days: scene.estimated_shoot_days || 1,
          budget: Math.round(scene.budget || 0),
          notes: scene.notes || ''
        }));

        const { data: sceneData, error: sceneError } = await supabase
          .from('scene_cards')
          .insert(sceneCardsToInsert)
          .select();

        if (sceneError) {
          console.error('Failed to insert scene cards:', sceneError);
        } else {
          sceneCards.push(...sceneData);
        }
      }

      // Store budget items if we have them
      const budgetItems: BudgetItem[] = [];
      if (structuredData.budget_items && structuredData.budget_items.length > 0) {
        const budgetItemsToInsert = structuredData.budget_items.map((item: any) => {
          // Ensure rate and total are both in cents for consistency
          let rate = item.rate || 0;
          let total = item.total || 0;
          
          // If rate seems to be in dollars (too small compared to total), convert to cents
          if (rate > 0 && total > 0 && total > rate * 50) {
            // Total is much larger than rate, likely rate is in dollars and total is in cents
            rate = rate * 100;
          }
          
          // Recalculate total to ensure consistency (rate and total should both be in cents)
          total = (item.quantity || 1) * rate;
          
          return {
            project_id: projectId,
            user_id: userId,
            category_name: item.category_name,
            item_name: item.item_name,
            quantity: item.quantity || 1,
            rate: Math.round(rate),
            unit: item.unit || 'project',
            total: Math.round(total),
            notes: item.notes || '',
            is_estimated: true
          };
        });

        const { data: budgetData, error: budgetError } = await supabase
          .from('production_budgets')
          .insert(budgetItemsToInsert)
          .select();

        if (budgetError) {
          console.error('Failed to insert budget items:', budgetError);
        } else {
          budgetItems.push(...budgetData);
        }
      }

      return {
        analysis: structuredData.analysis || aiResponse,
        sceneCards,
        budgetItems
      };

    } catch (error) {
      console.error('Production analysis service error:', error);
      throw error;
    }
  }

  /**
   * Get editable analysis data for a project
   * Note: Access control should be verified by the caller before invoking this method
   */
  static async getEditableAnalysisData(projectId: string, userId: string) {
    try {
      // Get all production data for the project (filtered by project_id only)
      const [analysisResult, sceneCardsResult, budgetResult] = await Promise.all([
        supabase
          .from('production_analyses')
          .select('*')
          .eq('project_id', projectId)
          .order('created_at', { ascending: false }),

        supabase
          .from('scene_cards')
          .select('*')
          .eq('project_id', projectId)
          .order('scene_number'),

        supabase
          .from('production_budgets')
          .select('*')
          .eq('project_id', projectId)
          .order('category_name', { ascending: true })
      ]);

      return {
        analyses: analysisResult.data || [],
        sceneCards: sceneCardsResult.data || [],
        budgetItems: budgetResult.data || []
      };

    } catch (error) {
      console.error('Failed to get editable analysis data:', error);
      throw error;
    }
  }

  /**
   * Update a scene card
   * Note: Access control should be verified by the caller before invoking this method
   */
  static async updateSceneCard(sceneId: string, userId: string, updates: Partial<SceneCard>) {
    try {
      const { data, error } = await supabase
        .from('scene_cards')
        .update(updates)
        .eq('id', sceneId)
        .select()
        .single();

      if (error) throw error;
      return data;

    } catch (error) {
      console.error('Failed to update scene card:', error);
      throw error;
    }
  }

  /**
   * Update a budget item
   * Note: Access control should be verified by the caller before invoking this method
   */
  static async updateBudgetItem(itemId: string, userId: string, updates: Partial<BudgetItem>) {
    try {
      // Map 'category' to 'category_name' for database compatibility
      const { category, ...restUpdates } = updates as Record<string, unknown>;
      const mappedUpdates = {
        ...restUpdates,
        ...(category ? { category_name: category } : {}),
        is_estimated: false // Mark as manually edited
      };

      const { data, error } = await supabase
        .from('production_budgets')
        .update(mappedUpdates)
        .eq('id', itemId)
        .select()
        .single();

      if (error) throw error;
      return data;

    } catch (error) {
      console.error('Failed to update budget item:', error);
      throw error;
    }
  }

  /**
   * Create schedule from scenes
   * Note: Access control should be verified by the caller before invoking this method
   */
  static async createScheduleFromScenes(projectId: string, userId: string, sceneIds: string[]) {
    try {
      // Get scene cards for scheduling (filtered by project_id only)
      const { data: scenes, error: sceneError } = await supabase
        .from('scene_cards')
        .select('*')
        .eq('project_id', projectId)
        .in('id', sceneIds);

      if (sceneError) throw sceneError;
      if (!scenes || scenes.length === 0) return [];

      // Generate AI-optimized schedule
      const schedulePrompt = `
Create an optimal shooting schedule for these scenes:

${scenes.map(scene => `
Scene ${scene.scene_number}: ${scene.heading}
- Location: ${scene.location}
- Time: ${scene.time_of_day}  
- Characters: ${scene.characters.join(', ')}
- Days needed: ${scene.estimated_shoot_days}
- Complexity: ${scene.complexity}
`).join('\n')}

Return a JSON array of schedule items:
[
  {
    "scene_id": "uuid",
    "shoot_date": "2024-03-01",
    "start_time": "08:00",
    "end_time": "18:00",
    "location": "Studio A",
    "crew_requirements": {"camera_op": 1, "sound": 1, "lighting": 2},
    "equipment_requirements": ["Camera", "Lighting Kit", "Audio Kit"],
    "notes": "Group location scenes together"
  }
]
`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [
          {
            role: 'user',
            content: schedulePrompt
          }
        ],
        max_completion_tokens: 1500
      });

      const aiResponse = completion.choices[0].message.content!;
      let scheduleItems = [];

      try {
        const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          scheduleItems = JSON.parse(jsonMatch[0]);
        }
      } catch (parseError) {
        console.error('Failed to parse schedule JSON:', parseError);
      }

      // Insert schedule items into database
      if (scheduleItems.length > 0) {
        const scheduleInserts = scheduleItems.map((item: any) => ({
          project_id: projectId,
          user_id: userId,
          scene_id: item.scene_id,
          shoot_date: item.shoot_date,
          start_time: item.start_time,
          end_time: item.end_time,
          location: item.location,
          crew_requirements: item.crew_requirements || {},
          equipment_requirements: item.equipment_requirements || [],
          notes: item.notes || ''
        }));

        const { data: scheduleData, error: scheduleError } = await supabase
          .from('production_schedules')
          .insert(scheduleInserts)
          .select();

        if (scheduleError) {
          console.error('Failed to insert schedule items:', scheduleError);
          return [];
        }

        return scheduleData;
      }

      return [];

    } catch (error) {
      console.error('Failed to create schedule:', error);
      throw error;
    }
  }

  /**
   * Analyze all project data and fill production module with AI-generated content
   */
  static async analyzeProjectAndFillProduction(
    projectId: string,
    userId: string,
    projectData: {
      script?: any;
      storyboard?: any[];
      characters?: any[];
      locations?: any[];
      documents?: any[];
      projectType: string;
      generateOnly?: 'cast' | 'crew' | 'budget'; // Optional: specify what to generate
      episodeId?: string; // Optional episode ID for TV series
    },
    projectSettings: {
      language?: string;
      content_language?: string;
    } = {}
  ) {
    try {
      // Gather and analyze all available project content
      const analysisContent = this.prepareProjectAnalysisData(projectData);

      if (!analysisContent.hasContent) {
        throw new Error('No script, storyboard, or project content found to analyze');
      }

      // Get project location data for regional cost adaptation
      const locationData = await this.getProjectLocationData(projectId, userId);

      // Generate comprehensive production data with AI
      const aiResult = await this.generateComprehensiveProductionData(
        analysisContent,
        projectData.projectType,
        locationData,
        projectSettings,
        projectData.generateOnly
      );

      // Store all generated data in database (respecting generateOnly filter)
      const storedData = await this.storeComprehensiveProductionData(
        projectId,
        userId,
        aiResult,
        projectData.episodeId, // Pass episode_id for TV series
        projectData.generateOnly // Pass generateOnly to filter what gets stored
      );

      return {
        scenes: storedData.scenes,
        budget: storedData.budget,
        cast: storedData.cast || [],
        crew: storedData.crew || [],
        locations: aiResult.locations || [],
        timeOfDay: aiResult.timeOfDay || [],
        props: aiResult.props || [],
        vehicles: aiResult.vehicles || [],
        totalBudget: aiResult.totalBudget || 0,
        totalShootDays: aiResult.totalShootDays || 0
      };

    } catch (error) {
      console.error('Failed to analyze project and fill production:', error);
      throw error;
    }
  }

  /**
   * Prepare all project data for comprehensive AI analysis
   */
  private static prepareProjectAnalysisData(projectData: any) {
    const analysis = {
      content: '',
      hasContent: false,
      projectType: projectData.projectType
    };

    // Extract script content
    if (projectData.script?.content) {
      analysis.content += `SCRIPT:\n${extractTextFromTipTapJSON(projectData.script.content)}\n\n`;
      analysis.hasContent = true;
    }

    // Extract storyboard content
    if (projectData.storyboard?.length > 0) {
      analysis.content += `STORYBOARD:\n${this.extractStoryboardText(projectData.storyboard)}\n\n`;
      analysis.hasContent = true;
    }

    // Extract character information
    if (projectData.characters?.length > 0) {
      analysis.content += `CHARACTERS:\n${this.extractCharacterInfo(projectData.characters)}\n\n`;
      analysis.hasContent = true;
    }

    // Extract location information
    if (projectData.locations?.length > 0) {
      analysis.content += `LOCATIONS:\n${this.extractLocationInfo(projectData.locations)}\n\n`;
      analysis.hasContent = true;
    }

    // Extract document information  
    if (projectData.documents?.length > 0) {
      analysis.content += `PROJECT DOCUMENTS:\n${this.extractDocumentInfo(projectData.documents)}\n\n`;
      analysis.hasContent = true;
    }

    return analysis;
  }

  /**
   * Get project location data for regional cost adaptation
   * Note: Access control should be verified by the caller before invoking this method
   */
  private static async getProjectLocationData(projectId: string, userId: string) {
    try {
      // Get project location info (filtered by project_id only)
      const { data: projectData, error: projectError } = await supabase
        .from('projects')
        .select('production_country, production_region, production_city, currency, cost_multiplier')
        .eq('id', projectId)
        .single();

      if (projectError || !projectData) {
        return null;
      }

      // Get detailed regional cost data if country is specified
      let regionalCosts = null;
      if (projectData.production_country) {
        const { data: costData, error: costError } = await supabase
          .from('regional_cost_data')
          .select('*')
          .eq('country_code', projectData.production_country.toUpperCase())
          .single();

        if (!costError && costData) {
          regionalCosts = costData;
        }
      }

      return {
        ...projectData,
        regionalCosts
      };
    } catch (error) {
      console.error('Error getting project location data:', error);
      return null;
    }
  }

  /**
   * Generate comprehensive production data using AI
   */
  private static async generateComprehensiveProductionData(
    analysisData: any,
    projectType: string,
    locationData: any = null,
    projectSettings: any = {},
    generateOnly?: 'cast' | 'crew' | 'budget'
  ) {
    // Build location context for the prompt
    let locationContext = '';
    if (locationData && locationData.regionalCosts) {
      const costs = locationData.regionalCosts;
      locationContext = `
PRODUCTION LOCATION: ${costs.country_name} (${costs.region})
CURRENCY: ${costs.currency}
REGIONAL COST FACTORS:
- Base cost multiplier: ${costs.cost_multiplier}x
- Crew rates: ${costs.crew_multiplier}x (avg daily rate: $${(costs.avg_daily_crew_rate / 100).toLocaleString()})
- Equipment: ${costs.equipment_multiplier}x  
- Locations: ${costs.location_multiplier}x (avg daily rate: $${(costs.avg_location_day_rate / 100).toLocaleString()})
- Talent: ${costs.talent_multiplier}x
- Post-production: ${costs.post_production_multiplier}x
- Tax rate: ${(costs.tax_rate * 100).toFixed(1)}%
- Film incentives: ${costs.tax_incentives < 0 ? `${Math.abs(costs.tax_incentives * 100)}% rebate` : `${costs.tax_incentives * 100}% additional tax`}
NOTES: ${costs.notes}

IMPORTANT: Apply these regional cost multipliers to ALL budget calculations. Use ${costs.currency} as the base currency.
`;
    } else if (locationData?.production_country) {
      locationContext = `
PRODUCTION LOCATION: ${locationData.production_country}
${locationData.production_region ? `REGION: ${locationData.production_region}` : ''}
${locationData.production_city ? `CITY: ${locationData.production_city}` : ''}
CURRENCY: ${locationData.currency || 'USD'}
${locationData.cost_multiplier ? `COST MULTIPLIER: ${locationData.cost_multiplier}x` : ''}

IMPORTANT: Research typical production costs for ${locationData.production_country} and adjust all budget estimates accordingly.
`;
    }

    // Build language context for the prompt
    let languageContext = '';
    if (projectSettings.language || projectSettings.content_language) {
      const outputLanguage = projectSettings.language || 'English';
      const contentLanguage = projectSettings.content_language || projectSettings.language || 'English';
      
      const languageMap = {
        'en': 'English',
        'es': 'Spanish',
        'fr': 'French',
        'de': 'German',
        'it': 'Italian',
        'pt': 'Portuguese',
        'ru': 'Russian',
        'ja': 'Japanese',
        'zh': 'Chinese',
        'hi': 'Hindi',
        'ar': 'Arabic',
        'ko': 'Korean'
      };
      
      const outputLangName = languageMap[outputLanguage] || outputLanguage;
      const contentLangName = languageMap[contentLanguage] || contentLanguage;
      
      languageContext = `
LANGUAGE REQUIREMENTS:
- Script/Content Language: ${contentLangName}
- Response Language: ${outputLangName}
- Character names should reflect the content language/culture
- Location names should be appropriate for the content language
- ALL text in the response must be in ${outputLangName}
- Budget categories and descriptions must be in ${outputLangName}
- Scene descriptions and notes must be in ${outputLangName}

IMPORTANT: Generate ALL output text in ${outputLangName}. This includes scene descriptions, budget category names, character names, and all other text content.
`;
    }

    // Build focused or comprehensive prompt based on generateOnly
    const prompt = generateOnly
      ? this.buildFocusedPrompt(generateOnly, analysisData, projectType, locationContext, languageContext)
      : this.buildComprehensivePrompt(analysisData, projectType, locationContext, languageContext);

    // Use fewer tokens for focused generation
    const maxTokens = generateOnly ? 16000 : 32000;

    let response;
    try {
      response = await openai.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a film production manager. Create production data in the exact JSON format requested. Be concise and direct. Start your response immediately with valid JSON - no explanations or markdown.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_completion_tokens: maxTokens
      });
    } catch (apiError) {
      console.error('OpenAI API Error:', apiError);
      throw new Error(`OpenAI API call failed: ${apiError.message}`);
    }

    
    const choice = response.choices[0];
    const aiResponse = choice?.message?.content;
    const finishReason = choice?.finish_reason;
    
    if (!aiResponse) {
      if (finishReason === 'length') {
        console.error('AI response was cut off due to token limits. Consider reducing prompt complexity or increasing max_completion_tokens further.');
        throw new Error('AI response was truncated due to token limits. Please try with a smaller project or contact support.');
      }
      console.error('No AI response content. Full response:', JSON.stringify(response, null, 2));
      throw new Error('No response from AI service');
    }
    
    if (finishReason === 'length') {
      console.warn('AI response may be incomplete due to token limits, but we have some content to work with.');
    }

    // Use repair-capable JSON extractor to handle truncated/malformed AI responses
    const extractionResult = extractJsonFromAIResponseWithRepair(aiResponse);

    if (!extractionResult.success || !extractionResult.json) {
      console.error('Error parsing AI response:', extractionResult.error);
      if (extractionResult.extractedContent) {
        console.error('Extracted content preview:', extractionResult.extractedContent.substring(0, 500));
      }
      throw new Error('Failed to parse AI-generated production data');
    }

    return extractionResult.json;
  }

  /**
   * Store comprehensive production data in database
   */
  private static async storeComprehensiveProductionData(
    projectId: string,
    userId: string,
    productionData: any,
    episodeId?: string, // Optional episode ID for TV series
    generateOnly?: 'cast' | 'crew' | 'budget' // Optional: only store specific type
  ) {
    const results: any = {
      scenes: [],
      budget: [],
      cast: [],
      crew: []
    };

    // Determine what to store based on generateOnly parameter
    const shouldStoreScenes = !generateOnly; // Only store scenes for full generation
    const shouldStoreBudget = !generateOnly || generateOnly === 'budget';
    const shouldStoreCast = !generateOnly || generateOnly === 'cast';
    const shouldStoreCrew = !generateOnly || generateOnly === 'crew';

    try {
      // Store scenes (only for full generation, not for selective)
      if (shouldStoreScenes && productionData.scenes?.length > 0) {
        for (const scene of productionData.scenes) {
          const { data, error } = await supabase
            .from('scene_cards')
            .upsert({
              project_id: projectId,
              user_id: userId,
              scene_number: scene.number,
              heading: scene.heading,
              location: scene.location,
              time_of_day: scene.timeOfDay,
              complexity: scene.complexity,
              characters: scene.characters || [],
              estimated_shoot_days: scene.estimatedShootDays || 1,
              budget: scene.budget || 0,
              status: 'planned'
            }, { 
              onConflict: 'project_id,scene_number' 
            })
            .select()
            .single();

          if (error) {
            console.error('Error storing scene:', error);
          } else if (data) {
            results.scenes.push({
              id: data.id,
              number: data.scene_number,
              heading: data.heading,
              location: data.location,
              timeOfDay: data.time_of_day,
              complexity: data.complexity,
              characters: data.characters,
              estimatedShootDays: data.estimated_shoot_days,
              budget: data.budget,
              shots: []
            });
          }
        }
      }

      // Store budget items (only if not filtered out)
      if (shouldStoreBudget && productionData.budget?.length > 0) {
        for (const category of productionData.budget) {
          const budgetCategory = {
            name: category.name,
            items: [],
            total: 0
          };

          if (category.items?.length > 0) {
            for (const item of category.items) {
              // Ensure rate and total are both in cents for consistency
              let rate = item.rate || 0;
              let total = item.total || 0;

              // If rate seems to be in dollars (too small compared to total), convert to cents
              if (rate > 0 && total > 0 && total > rate * 50) {
                // Total is much larger than rate, likely rate is in dollars and total is in cents
                rate = rate * 100;
              }

              // Recalculate total to ensure consistency (rate and total should both be in cents)
              total = (item.quantity || 1) * rate;

              // Unified: always use production_budgets, with optional episode_id for TV series
              const budgetItem: Record<string, any> = {
                project_id: projectId,
                user_id: userId,
                category_name: category.name,
                item_name: item.name,
                quantity: item.quantity || 1,
                rate: rate,
                unit: item.unit || 'project',
                total: total,
                notes: item.description || '',
                is_estimated: true
              };

              // Set episode_id for TV series episodes
              if (episodeId) {
                budgetItem.episode_id = episodeId;
              }

              const { data, error } = await supabase
                .from('production_budgets')
                .insert(budgetItem)
                .select()
                .single();

              if (error) {
                console.error('Error storing budget item:', error);
              } else if (data) {
                budgetCategory.items.push({
                  id: data.id,
                  name: data.item_name,
                  description: data.notes,
                  quantity: data.quantity,
                  rate: data.rate,
                  unit: data.unit,
                  total: data.total
                });
                budgetCategory.total += data.total;
              }
            }
          }

          if (budgetCategory.items.length > 0) {
            results.budget.push(budgetCategory);
          }
        }
      }

      // Derive season_id from episode_id for TV series cast/crew
      let seasonId: string | null = null;
      if (episodeId) {
        const { data: episodeData } = await supabase
          .from('episodes')
          .select('season_id')
          .eq('id', episodeId)
          .single();
        seasonId = episodeData?.season_id || null;
      }

      // Store cast members (only if not filtered out)
      if (shouldStoreCast && productionData.cast?.length > 0) {
        for (const castMember of productionData.cast) {
          const castInsert: Record<string, any> = {
            project_id: projectId,
            user_id: userId,
            character_name: castMember.character_name,
            actor_name: castMember.actor_name || `Actor ${results.cast.length + 1}`,
            category: castMember.category || 'supporting',
            rate_per_day: castMember.rate_per_day || 0,
            actor_contact: null
          };

          if (seasonId) {
            castInsert.season_id = seasonId;
          }

          const { data, error } = await supabase
            .from('production_cast')
            .insert(castInsert)
            .select()
            .single();

          if (error) {
            console.error('Error storing cast member:', error);
          } else if (data) {
            results.cast.push({
              id: data.id,
              character_name: data.character_name,
              actor_name: data.actor_name,
              category: data.category,
              rate_per_day: data.rate_per_day
            });
          }
        }
      }

      // Store crew members (only if not filtered out)
      if (shouldStoreCrew && productionData.crew?.length > 0) {
        for (const crewMember of productionData.crew) {
          const crewInsert: Record<string, any> = {
            project_id: projectId,
            user_id: userId,
            name: crewMember.name || `Crew Member ${results.crew.length + 1}`,
            role: crewMember.role,
            department: crewMember.department || 'Production',
            rate_per_day: crewMember.rate_per_day || 0,
            rate_per_hour: crewMember.rate_per_hour || null,
            contact: null
          };

          if (seasonId) {
            crewInsert.season_id = seasonId;
          }

          const { data, error } = await supabase
            .from('production_crew')
            .insert(crewInsert)
            .select()
            .single();

          if (error) {
            console.error('Error storing crew member:', error);
          } else if (data) {
            results.crew.push({
              id: data.id,
              name: data.name,
              role: data.role,
              department: data.department,
              rate_per_day: data.rate_per_day,
              rate_per_hour: data.rate_per_hour
            });
          }
        }
      }

    } catch (error) {
      console.error('Error storing comprehensive production data:', error);
      throw new Error('Failed to store production data in database');
    }

    return results;
  }

  // extractTextFromTipTapContent replaced by unified extractTextFromTipTapJSON from aiHelpers

  /**
   * Build a focused prompt for a specific generation type (budget, cast, or crew)
   * Much smaller than the comprehensive prompt — faster and less likely to truncate
   */
  private static buildFocusedPrompt(
    generateOnly: 'cast' | 'crew' | 'budget',
    analysisData: any,
    projectType: string,
    locationContext: string,
    languageContext: string
  ): string {
    const baseContext = `Analyze the following ${projectType} project data:\n\n${analysisData.content}\n${locationContext}\n${languageContext}\n`;
    const centsNote = `\nCRITICAL: ALL MONETARY VALUES MUST BE IN CENTS (multiply dollars by 100). Example: $1,000 = 100000 cents.\nBe realistic with production costs based on industry standards.`;

    if (generateOnly === 'budget') {
      return `${baseContext}
Generate a detailed BUDGET BREAKDOWN with these categories:
- Pre-production costs (script development, location scouting, casting)
- Cast costs (budget items for each main character with estimated daily rate × shoot days)
- Crew costs (budget items for key crew roles with daily rate × shoot days)
- Equipment and rentals (cameras, lighting, sound, grip)
- Location costs (location fees, permits)
- Post-production costs (editing, color, sound, VFX)
- Other production expenses (catering, transportation, insurance)

Return JSON:
{
  "budget": [
    {
      "name": "Category Name",
      "items": [{ "name": "Item", "description": "Details", "quantity": 1, "rate": 100000, "unit": "day", "total": 100000 }]
    }
  ],
  "totalBudget": 15000000,
  "totalShootDays": 12
}
${centsNote}`;
    }

    if (generateOnly === 'cast') {
      return `${baseContext}
For EACH character in the script, create a cast entry:
- character_name: The character's name from the script
- actor_name: Placeholder like "Actor 1", "Actor 2"
- category: "lead", "supporting", "day_player", "extra", or "background"
- rate_per_day: Estimated daily rate in CENTS

Return JSON:
{
  "cast": [
    { "character_name": "JOHN", "actor_name": "Actor 1", "category": "lead", "rate_per_day": 100000 }
  ]
}
${centsNote}`;
    }

    // generateOnly === 'crew'
    return `${baseContext}
Based on script complexity, generate crew positions:
- name: Placeholder like "Crew Member 1"
- role: Specific position (Director, DP, Gaffer, Sound Mixer, etc.)
- department: Production, Camera, Lighting, Sound, Art, etc.
- rate_per_day: Industry standard daily rate in CENTS
- rate_per_hour: Optional hourly rate in CENTS

Include essential crew: Director, DP, Sound Recordist, Production Manager, plus additional roles based on complexity.

Return JSON:
{
  "crew": [
    { "name": "Crew Member 1", "role": "Director", "department": "Production", "rate_per_day": 200000 }
  ]
}
${centsNote}`;
  }

  /**
   * Build the full comprehensive prompt for generating all production data
   */
  private static buildComprehensivePrompt(
    analysisData: any,
    projectType: string,
    locationContext: string,
    languageContext: string
  ): string {
    return `You are a professional film production manager. Analyze the following ${projectType} project data and generate a comprehensive production breakdown.

${analysisData.content}
${locationContext}
${languageContext}

Generate a detailed production analysis including:

1. SCENE BREAKDOWN:
   - Scene number, heading, location, time of day
   - Characters in each scene
   - Estimated shooting days per scene
   - Complexity level (simple/medium/complex)
   - Estimated budget per scene

2. BUDGET BREAKDOWN:
   - Pre-production costs (script development, location scouting, casting)
   - Cast costs (create budget items for EACH cast member with their rate_per_day × shoot days)
   - Crew costs (create budget items for EACH crew member with their rate_per_day × shoot days)
   - Equipment and rentals (cameras, lighting, sound, grip)
   - Location costs (location fees, permits)
   - Post-production costs (editing, color, sound, VFX)
   - Other production expenses (catering, transportation, insurance)

   IMPORTANT: Generate individual budget line items for:
   - Each cast member: "Cast - [Character Name] ([Category])" with their daily rate × total shoot days
   - Each crew member: "Crew - [Role] ([Department])" with their daily rate × total shoot days
   - Make sure cast and crew budget items match the cast and crew arrays generated

3. CAST REQUIREMENTS:
   - For EACH character in the script, create a cast entry with:
     * character_name: The character's name from the script
     * actor_name: A placeholder like "Actor 1", "Actor 2", etc.
     * category: "lead", "supporting", "day_player", "extra", or "background"
     * rate_per_day: Estimated daily rate in CENTS based on role importance and age group
   - Consider character age groups (Child, Teen, Adult, Senior) when estimating rates
   - Child actors typically have lower rates and require guardians/teachers
   - DO NOT leave actor_name empty - always use "Actor [Number]" format

4. CREW REQUIREMENTS:
   - Based on script complexity and production needs, generate crew positions with:
     * name: Placeholder like "Crew Member 1", "Crew Member 2"
     * role: Specific crew position (Director, DP, Gaffer, Sound Mixer, etc.)
     * department: Production, Camera, Lighting, Sound, Art, etc.
     * rate_per_day: Industry standard daily rate in CENTS for that position
     * rate_per_hour: Optional hourly rate in CENTS if applicable
   - Include essential crew based on project type and complexity:
     * Minimum: Director, DP, Sound Recordist, Production Manager
     * Medium: Add Gaffer, Key Grip, Art Director, Makeup Artist
     * Complex: Add full departments as needed

5. LOCATION REQUIREMENTS:
   - Primary filming locations
   - Location rental costs
   - Special requirements

6. PRODUCTION ELEMENTS:
   - Key props needed
   - Special equipment
   - Vehicles required
   - Time of day requirements

Return the data in JSON format with the following structure:
{
  "scenes": [
    {
      "number": 1,
      "heading": "INT. KITCHEN - DAY",
      "location": "Kitchen",
      "timeOfDay": "day",
      "characters": ["JOHN", "MARY"],
      "complexity": "simple",
      "estimatedShootDays": 0.5,
      "budget": 250000
    }
  ],
  "budget": [
    {
      "name": "Pre-Production",
      "items": [
        {
          "name": "Script Development",
          "description": "Final script polish and revisions",
          "quantity": 1,
          "rate": 500000,
          "unit": "project",
          "total": 500000
        }
      ]
    },
    {
      "name": "Cast",
      "items": [
        {
          "name": "Cast - JOHN (lead)",
          "description": "Lead actor daily rate for 10 shoot days",
          "quantity": 10,
          "rate": 100000,
          "unit": "day",
          "total": 1000000
        },
        {
          "name": "Cast - MARY (supporting)",
          "description": "Supporting actor daily rate for 5 shoot days",
          "quantity": 5,
          "rate": 50000,
          "unit": "day",
          "total": 250000
        }
      ]
    },
    {
      "name": "Crew",
      "items": [
        {
          "name": "Crew - Director (Production)",
          "description": "Director daily rate for 10 shoot days",
          "quantity": 10,
          "rate": 200000,
          "unit": "day",
          "total": 2000000
        },
        {
          "name": "Crew - Director of Photography (Camera)",
          "description": "DP daily rate for 10 shoot days",
          "quantity": 10,
          "rate": 150000,
          "unit": "day",
          "total": 1500000
        }
      ]
    }
  ],
  "cast": [
    {
      "character_name": "JOHN",
      "actor_name": "Actor 1",
      "category": "lead",
      "rate_per_day": 100000
    },
    {
      "character_name": "MARY",
      "actor_name": "Actor 2",
      "category": "supporting",
      "rate_per_day": 50000
    }
  ],
  "crew": [
    {
      "name": "Crew Member 1",
      "role": "Director",
      "department": "Production",
      "rate_per_day": 200000
    },
    {
      "name": "Crew Member 2",
      "role": "Director of Photography",
      "department": "Camera",
      "rate_per_day": 150000
    },
    {
      "name": "Crew Member 3",
      "role": "Sound Mixer",
      "department": "Sound",
      "rate_per_day": 80000,
      "rate_per_hour": 10000
    }
  ],
  "locations": ["Kitchen", "Office", "Park"],
  "timeOfDay": ["day", "night"],
  "props": ["coffee mug", "laptop", "car keys"],
  "vehicles": ["car", "truck"],
  "totalBudget": 15000000,
  "totalShootDays": 12
}

CRITICAL: ALL MONETARY VALUES MUST BE IN CENTS (multiply dollars by 100).
- Example: $1,000 = 100000 cents
- Example: $50,000 = 5000000 cents
- Example: $250 per day = 25000 cents
- Cast should be objects with name, role, and estimatedRate in CENTS
Be realistic with production costs based on industry standards.`;
  }

  private static extractStoryboardText(storyboards: any[]): string {
    // Handle storyboard_panels format (array of panels)
    if (Array.isArray(storyboards) && storyboards.length > 0) {
      return storyboards.map(panel => {
        const description = panel.scene_description || panel.description || '';
        const shotType = panel.shot_type || '';
        const notes = panel.notes || '';
        return `Panel ${panel.panel_number || ''}: ${description}\nShot: ${shotType}\nNotes: ${notes}`;
      }).join('\n\n');
    }
    
    // Handle legacy storyboards format (array of storyboard objects with scenes)
    return storyboards.map(board => {
      const scenes = board.scenes || [];
      return scenes.map((scene: any) => {
        return `Scene ${scene.scene_number}: ${scene.description || ''}\nShots: ${(scene.shots || []).length}`;
      }).join('\n');
    }).join('\n\n');
  }

  private static extractCharacterInfo(characters: any[]): string {
    return characters.map(char => {
      const details = [];

      // Add basic info
      details.push(char.name);

      // Add age and age group
      if (char.age) {
        const age = parseInt(char.age);
        let ageGroup = 'Adult';
        if (age < 13) ageGroup = 'Child';
        else if (age < 18) ageGroup = 'Teen';
        else if (age > 65) ageGroup = 'Senior';
        details.push(`Age: ${char.age} (${ageGroup})`);
      }

      // Add gender
      if (char.gender) {
        details.push(`Gender: ${char.gender}`);
      }

      // Add description
      if (char.description) {
        details.push(`Description: ${char.description}`);
      }

      // Add role/importance
      if (char.importance || char.role) {
        details.push(`Role: ${char.importance || char.role}`);
      }

      return details.join(' | ');
    }).join('\n');
  }

  private static extractLocationInfo(locations: any[]): string {
    return locations.map(loc => {
      return `${loc.name}: ${loc.description || ''} (Type: ${loc.location_type || 'Unknown'})`;
    }).join('\n');
  }

  private static extractDocumentInfo(documents: any[]): string {
    return documents.map(document => {
      return `${document.title}: ${extractTextFromTipTapJSON(document.content)}`;
    }).join('\n\n');
  }
}