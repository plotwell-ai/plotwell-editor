import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth';
import { extractUserId } from '../middleware/pricingMiddleware';
import { createAIUsageTracker } from '../services/aiUsageTracker';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Get current month usage summary
router.get('/current', requireAuth, extractUserId, async (req: any, res) => {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const tracker = createAIUsageTracker(supabase);
    const { data, error } = await tracker.getUserUsageStats(userId, 'current_month');

    if (error) {
      console.error('Error getting current usage:', error);
      return res.status(500).json({ error: 'Failed to fetch usage data' });
    }

    // If no data, return zero usage
    const usage = data || {
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_tokens: 0,
      chat_completions_count: 0,
      image_generations_count: 0,
      total_cost_usd: 0,
      openai_cost_usd: 0,
      replicate_cost_usd: 0,
      script_generations: 0,
      concept_generations: 0,
      character_generations: 0,
      storyboard_generations: 0,
      image_generations: 0
    };

    // Get AI credits balance from user_quotas
    const { data: quotaData, error: quotaError } = await supabase
      .from('user_quotas')
      .select('ai_credits_balance')
      .eq('user_id', userId)
      .single();

    if (quotaError) {
      if (DEBUG_AI) console.log('No quota record found for user, balance is 0:', userId);
    }

    const aiCreditsBalance = quotaData?.ai_credits_balance || 0;
    if (DEBUG_AI) console.log('AI Credits balance for user', userId, ':', aiCreditsBalance);

    res.json({
      current: {
        usage: {
          projects: usage.projects_count || 0,
          aiGenerations: usage.chat_completions_count + usage.image_generations_count,
          aiImageCredits: usage.ai_image_credits_used || 0,
          collaborators: usage.collaborators_count || 0
        },
        ai_credits_balance: aiCreditsBalance,
        tokens: {
          prompt_tokens: usage.total_prompt_tokens,
          completion_tokens: usage.total_completion_tokens,
          total_tokens: usage.total_tokens
        },
        costs: {
          total_usd: parseFloat(usage.total_cost_usd || '0'),
          openai_usd: parseFloat(usage.openai_cost_usd || '0'),
          replicate_usd: parseFloat(usage.replicate_cost_usd || '0')
        },
        breakdown: {
          chat_completions: usage.chat_completions_count,
          script_generations: usage.script_generations,
          concept_generations: usage.concept_generations,
          character_generations: usage.character_generations,
          storyboard_generations: usage.storyboard_generations,
          image_generations: usage.image_generations_count
        }
      }
    });
  } catch (error) {
    console.error('Error in usage current endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get historical usage (last 6 months)
router.get('/history', requireAuth, extractUserId, async (req: any, res) => {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const tracker = createAIUsageTracker(supabase);
    const { data, error } = await tracker.getUserUsageStats(userId, 'last_6_months');

    if (error) {
      console.error('Error getting usage history:', error);
      return res.status(500).json({ error: 'Failed to fetch usage history' });
    }

    const historical = (data || []).map((month: any) => ({
      month: month.month,
      year: month.year,
      ai_generations_used: month.chat_completions_count + month.image_generations_count,
      ai_image_credits_used: month.ai_image_credits_used || 0,
      projects_count: month.projects_count || 0,
      total_tokens: month.total_tokens,
      total_cost_usd: parseFloat(month.total_cost_usd || '0')
    }));

    res.json({ historical });
  } catch (error) {
    console.error('Error in usage history endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get detailed usage breakdown for current month
router.get('/breakdown', requireAuth, extractUserId, async (req: any, res) => {
  try {
    const userId = req.userId;
    const month = req.query.month ? parseInt(req.query.month) : undefined;
    const year = req.query.year ? parseInt(req.query.year) : undefined;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const tracker = createAIUsageTracker(supabase);
    const breakdown = await tracker.getUsageBreakdown(userId, month, year);

    res.json(breakdown);
  } catch (error) {
    console.error('Error in usage breakdown endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all-time usage stats
router.get('/all-time', requireAuth, extractUserId, async (req: any, res) => {
  try {
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const tracker = createAIUsageTracker(supabase);
    const { data, error } = await tracker.getUserUsageStats(userId, 'all_time');

    if (error) {
      console.error('Error getting all-time usage:', error);
      return res.status(500).json({ error: 'Failed to fetch all-time usage' });
    }

    res.json({
      all_time: data || {
        total_tokens: 0,
        total_cost_usd: 0,
        ai_operations: 0,
        image_generations: 0
      }
    });
  } catch (error) {
    console.error('Error in usage all-time endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cost estimation removed - we only track token usage now

// Get recent usage events
router.get('/events', requireAuth, extractUserId, async (req: any, res) => {
  try {
    const userId = req.userId;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get recent AI usage events
    const { data: aiEvents, error: aiError } = await supabase
      .from('ai_usage_events')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Get recent image usage events
    const { data: imageEvents, error: imageError } = await supabase
      .from('image_usage_events')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (aiError || imageError) {
      console.error('Error getting usage events:', aiError || imageError);
      return res.status(500).json({ error: 'Failed to fetch usage events' });
    }

    // Combine and sort events by timestamp
    const allEvents = [
      ...(aiEvents || []).map(event => ({ ...event, event_type: 'ai_completion' })),
      ...(imageEvents || []).map(event => ({ ...event, event_type: 'image_generation' }))
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    res.json({
      events: allEvents.slice(0, limit),
      total: allEvents.length,
      offset,
      limit
    });
  } catch (error) {
    console.error('Error in usage events endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;