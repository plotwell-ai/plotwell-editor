import { createClient } from '@supabase/supabase-js';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AIUsageEvent {
  user_id: string;
  project_id?: string;
  operation_type: 'chat_completion' | 'script_generation' | 'concept_generation' | 'document_generation' | 'character_generation' | 'location_generation' | 'storyboard_generation' | 'image_generation' | 'character_image_generation' | 'storyboard_image_generation';
  model_used: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  request_id?: string;
  conversation_id?: string;
  duration_ms?: number;
  metadata?: Record<string, any>;
}

export interface ImageUsageEvent {
  user_id: string;
  project_id?: string;
  operation_type: 'character_image' | 'storyboard_image' | 'concept_art' | 'location_image' | 'presentation_image';
  service_provider: 'replicate' | 'openai' | 'stability_ai' | 'openrouter';
  model_used: string;
  image_dimensions?: string;
  image_format?: string;
  image_quality?: number;
  duration_ms?: number;
  image_url?: string;
  prompt_text?: string;
  metadata?: Record<string, any>;
}

export class AIUsageTracker {
  private supabase: any;

  constructor(supabaseClient: any) {
    this.supabase = supabaseClient;
  }

  /**
   * Track OpenAI API usage (tokens and model only)
   */
  async trackOpenAIUsage(
    userId: string, 
    operationType: AIUsageEvent['operation_type'],
    modelUsed: string,
    tokenUsage: TokenUsage,
    options: {
      projectId?: string;
      requestId?: string;
      conversationId?: string;
      durationMs?: number;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<void> {
    try {
      // Insert usage event (no cost calculation)
      const { error } = await this.supabase
        .from('ai_usage_events')
        .insert([{
          user_id: userId,
          project_id: options.projectId,
          operation_type: operationType,
          model_used: modelUsed,
          prompt_tokens: tokenUsage.prompt_tokens,
          completion_tokens: tokenUsage.completion_tokens,
          total_tokens: tokenUsage.total_tokens,
          request_id: options.requestId,
          conversation_id: options.conversationId,
          duration_ms: options.durationMs,
          metadata: options.metadata || {}
        }]);

      if (error) {
        console.error('Failed to track AI usage:', error);
        throw error;
      }

      // Update monthly summary with text AI counts
      await this.updateMonthlySummary(userId);

    } catch (error) {
      console.error('Error tracking OpenAI usage:', error);
      // Don't throw - we don't want usage tracking to break the main functionality
    }
  }

  /**
   * Track image generation usage (no cost calculation)
   */
  async trackImageGeneration(
    userId: string,
    operationType: ImageUsageEvent['operation_type'],
    serviceProvider: ImageUsageEvent['service_provider'],
    modelUsed: string,
    options: {
      projectId?: string;
      imageDimensions?: string;
      imageFormat?: string;
      imageQuality?: number;
      durationMs?: number;
      imageUrl?: string;
      promptText?: string;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<void> {
    if (DEBUG_AI) console.log(`📸 Tracking image generation for user ${userId}, type: ${operationType}`);
    try {
      // Insert image usage event (no cost calculation)
      const { error } = await this.supabase
        .from('image_usage_events')
        .insert([{
          user_id: userId,
          project_id: options.projectId,
          operation_type: operationType,
          service_provider: serviceProvider,
          model_used: modelUsed,
          image_dimensions: options.imageDimensions,
          image_format: options.imageFormat,
          image_quality: options.imageQuality,
          duration_ms: options.durationMs,
          image_url: options.imageUrl,
          prompt_text: options.promptText,
          metadata: options.metadata || {}
        }]);

      if (error) {
        console.error('❌ Failed to insert image_usage_events:', error);
        throw error;
      }

      if (DEBUG_AI) console.log('✅ Inserted into image_usage_events');

      // Update monthly summary
      await this.updateMonthlySummary(userId);

    } catch (error) {
      console.error('❌ Error tracking image generation:', error);
      // Don't throw - we don't want usage tracking to break the main functionality
    }
  }

  /**
   * Update monthly summary for a user
   * Aggregates both text AI events and image events into monthly_ai_usage_summary
   */
  private async updateMonthlySummary(userId: string): Promise<void> {
    try {
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();
      const monthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
      const monthEnd = currentMonth === 12
        ? `${currentYear + 1}-01-01`
        : `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`;

      // Count text AI events by operation type for current month
      const { data: aiEvents, error: aiError } = await this.supabase
        .from('ai_usage_events')
        .select('operation_type')
        .eq('user_id', userId)
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd);

      if (aiError) {
        console.error('❌ Failed to count AI events:', aiError);
        return;
      }

      // Aggregate counts by operation type
      const counts: Record<string, number> = {};
      for (const event of aiEvents || []) {
        counts[event.operation_type] = (counts[event.operation_type] || 0) + 1;
      }

      // Count image generations separately
      const { count: imageCount, error: imageError } = await this.supabase
        .from('image_usage_events')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd);

      if (imageError) {
        console.error('❌ Failed to count image generations:', imageError);
      }

      const summaryData = {
        chat_completions_count: counts['chat_completion'] || 0,
        script_generations: (counts['script_generation'] || 0),
        concept_generations: counts['concept_generation'] || 0,
        character_generations: counts['character_generation'] || 0,
        storyboard_generations: counts['storyboard_generation'] || 0,
        location_generations: counts['location_generation'] || 0,
        image_generations_count: imageCount || 0,
        updated_at: new Date().toISOString(),
      };

      if (DEBUG_AI) console.log(`📊 Monthly summary for user ${userId}:`, summaryData);

      // Upsert the monthly summary
      const { data: existingRecord } = await this.supabase
        .from('monthly_ai_usage_summary')
        .select('id')
        .eq('user_id', userId)
        .eq('month', currentMonth)
        .eq('year', currentYear)
        .maybeSingle();

      if (existingRecord) {
        const { error: updateError } = await this.supabase
          .from('monthly_ai_usage_summary')
          .update(summaryData)
          .eq('user_id', userId)
          .eq('month', currentMonth)
          .eq('year', currentYear);

        if (updateError) {
          console.error('❌ Failed to update monthly summary:', updateError);
        }
      } else {
        const { error: insertError } = await this.supabase
          .from('monthly_ai_usage_summary')
          .insert({
            user_id: userId,
            month: currentMonth,
            year: currentYear,
            ...summaryData,
          });

        if (insertError) {
          console.error('❌ Failed to insert monthly summary:', insertError);
        }
      }
    } catch (error) {
      console.error('❌ Error updating monthly summary:', error);
    }
  }

  /**
   * Get usage statistics for a user
   */
  async getUserUsageStats(
    userId: string,
    timeframe: 'current_month' | 'last_6_months' | 'all_time' = 'current_month'
  ): Promise<any> {
    try {
      if (timeframe === 'current_month') {
        const currentMonth = new Date().getMonth() + 1;
        const currentYear = new Date().getFullYear();

        const { data, error } = await this.supabase
          .from('monthly_ai_usage_summary')
          .select('*')
          .eq('user_id', userId)
          .eq('month', currentMonth)
          .eq('year', currentYear)
          .single();

        return { data, error };
      } else if (timeframe === 'last_6_months') {
        const { data, error } = await this.supabase
          .from('monthly_ai_usage_summary')
          .select('*')
          .eq('user_id', userId)
          .gte('created_at', new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000).toISOString())
          .order('year', { ascending: false })
          .order('month', { ascending: false });

        return { data, error };
      } else {
        // All time - aggregate from events
        const { data: aiUsage, error: aiError } = await this.supabase
          .from('ai_usage_events')
          .select('total_tokens, operation_type, model_used')
          .eq('user_id', userId);

        const { data: imageUsage, error: imageError } = await this.supabase
          .from('image_usage_events')
          .select('operation_type, model_used')
          .eq('user_id', userId);

        if (aiError || imageError) {
          return { data: null, error: aiError || imageError };
        }

        // Aggregate data (tokens and counts only)
        const totalTokens = aiUsage?.reduce((sum, event) => sum + (event.total_tokens || 0), 0) || 0;

        return {
          data: {
            total_tokens: totalTokens,
            ai_operations: aiUsage?.length || 0,
            image_generations: imageUsage?.length || 0,
            models_used: [...new Set([
              ...(aiUsage?.map(event => event.model_used) || []),
              ...(imageUsage?.map(event => event.model_used) || [])
            ])]
          },
          error: null
        };
      }
    } catch (error) {
      console.error('Error getting usage stats:', error);
      return { data: null, error };
    }
  }

  /**
   * Get detailed usage breakdown by operation type
   */
  async getUsageBreakdown(
    userId: string,
    month?: number,
    year?: number
  ): Promise<any> {
    try {
      const currentMonth = month || new Date().getMonth() + 1;
      const currentYear = year || new Date().getFullYear();

      // Get AI usage breakdown (no cost data)
      const { data: aiBreakdown, error: aiError } = await this.supabase
        .from('ai_usage_events')
        .select('operation_type, model_used, total_tokens, prompt_tokens, completion_tokens')
        .eq('user_id', userId)
        .gte('created_at', `${currentYear}-${currentMonth.toString().padStart(2, '0')}-01`)
        .lt('created_at', `${currentYear}-${(currentMonth + 1).toString().padStart(2, '0')}-01`);

      // Get image usage breakdown (no cost data)
      const { data: imageBreakdown, error: imageError } = await this.supabase
        .from('image_usage_events')
        .select('operation_type, service_provider, model_used')
        .eq('user_id', userId)
        .gte('created_at', `${currentYear}-${currentMonth.toString().padStart(2, '0')}-01`)
        .lt('created_at', `${currentYear}-${(currentMonth + 1).toString().padStart(2, '0')}-01`);

      if (aiError || imageError) {
        throw aiError || imageError;
      }

      return {
        ai_operations: aiBreakdown || [],
        image_operations: imageBreakdown || [],
        summary: {
          total_tokens: aiBreakdown?.reduce((sum, op) => sum + (op.total_tokens || 0), 0) || 0,
          total_prompt_tokens: aiBreakdown?.reduce((sum, op) => sum + (op.prompt_tokens || 0), 0) || 0,
          total_completion_tokens: aiBreakdown?.reduce((sum, op) => sum + (op.completion_tokens || 0), 0) || 0,
          total_operations: (aiBreakdown?.length || 0) + (imageBreakdown?.length || 0),
          ai_operations_count: aiBreakdown?.length || 0,
          image_generations_count: imageBreakdown?.length || 0
        }
      };
    } catch (error) {
      console.error('Error getting usage breakdown:', error);
      throw error;
    }
  }

  /**
   * Get operation count estimate
   */
  async getOperationCount(
    userId: string,
    operationType?: string,
    timeframe: 'today' | 'this_month' | 'all_time' = 'this_month'
  ): Promise<number> {
    try {
      const now = new Date();
      let startDate: string;
      
      switch (timeframe) {
        case 'today':
          startDate = now.toISOString().split('T')[0];
          break;
        case 'this_month':
          startDate = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-01`;
          break;
        default:
          startDate = '2000-01-01'; // All time
      }

      const query = this.supabase
        .from('ai_usage_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', startDate);

      if (operationType) {
        query.eq('operation_type', operationType);
      }

      const { count, error } = await query;

      if (error) {
        console.error('Error getting operation count:', error);
        return 0;
      }

      return count || 0;
    } catch (error) {
      console.error('Error getting operation count:', error);
      return 0;
    }
  }
}

// Helper function to create tracker instance
export function createAIUsageTracker(supabaseClient: any): AIUsageTracker {
  return new AIUsageTracker(supabaseClient);
}