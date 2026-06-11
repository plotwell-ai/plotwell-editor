// AI Routing Audit Logger
// Tracks model selection decisions for analytics and optimization

import { AIRoutingDecision, AIRoutingContext } from './aiModelRouter';
import { createClient } from '@supabase/supabase-js';

// Only log verbose AI details when explicitly enabled (local dev only)
const DEBUG_AI = process.env.DEBUG_AI === 'true';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase: ReturnType<typeof createClient> | null = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

export interface AIRoutingLog {
  id?: string;
  timestamp: string;
  user_id?: string;
  project_id?: string;
  endpoint: string;
  request_type: string;
  selected_model: string;
  provider: string;
  routing_reason: string;
  input_size: number;
  expected_output_tokens: number;
  actual_prompt_tokens?: number;
  actual_completion_tokens?: number;
  actual_total_tokens?: number;
  estimated_cost: string;
  had_attachments: boolean;
  metadata?: any;
}

export class AIRoutingLogger {
  private static inMemoryLogs: AIRoutingLog[] = [];
  private static maxInMemoryLogs = 1000;

  /**
   * Log a routing decision
   */
  public static async logRoutingDecision(params: {
    userId?: string;
    projectId?: string;
    endpoint: string;
    context: AIRoutingContext;
    decision: AIRoutingDecision;
    actualUsage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  }): Promise<void> {
    const log: AIRoutingLog = {
      timestamp: new Date().toISOString(),
      user_id: params.userId,
      project_id: params.projectId,
      endpoint: params.endpoint,
      request_type: params.context.requestType,
      selected_model: params.decision.selectedModel,
      provider: params.decision.provider,
      routing_reason: params.decision.reason,
      input_size: params.context.inputSize.chars,
      expected_output_tokens: params.context.expectedOutput.maxTokens,
      actual_prompt_tokens: params.actualUsage?.prompt_tokens,
      actual_completion_tokens: params.actualUsage?.completion_tokens,
      actual_total_tokens: params.actualUsage?.total_tokens,
      estimated_cost: params.decision.estimatedCost,
      had_attachments: params.context.inputSize.hasAttachments || false,
      metadata: params.context.metadata
    };

    // Store in memory
    this.inMemoryLogs.push(log);
    if (this.inMemoryLogs.length > this.maxInMemoryLogs) {
      this.inMemoryLogs.shift(); // Remove oldest
    }

    // Try to persist to database (non-blocking)
    if (supabase) {
      try {
        // Note: This requires a database table. For now, just log to console
        // In production, create ai_routing_logs table and uncomment below:
        // await supabase.from('ai_routing_logs').insert([log]);
        if (DEBUG_AI) {
          console.log(`📊 AI ROUTING LOG: ${log.selected_model} for ${log.endpoint} - ${log.routing_reason}`);
        }
      } catch (error) {
        console.error('Failed to persist routing log:', error);
      }
    }
  }

  /**
   * Get routing statistics
   */
  public static getStatistics(filters?: {
    userId?: string;
    projectId?: string;
    startDate?: Date;
    endDate?: Date;
  }): {
    totalRequests: number;
    modelBreakdown: Record<string, number>;
    providerBreakdown: Record<string, number>;
    averageInputSize: number;
    averageOutputSize: number;
    costEstimate: Record<string, number>;
  } {
    let logs = this.inMemoryLogs;

    // Apply filters
    if (filters) {
      if (filters.userId) {
        logs = logs.filter(l => l.user_id === filters.userId);
      }
      if (filters.projectId) {
        logs = logs.filter(l => l.project_id === filters.projectId);
      }
      if (filters.startDate) {
        logs = logs.filter(l => new Date(l.timestamp) >= filters.startDate!);
      }
      if (filters.endDate) {
        logs = logs.filter(l => new Date(l.timestamp) <= filters.endDate!);
      }
    }

    // Calculate statistics
    const modelBreakdown: Record<string, number> = {};
    const providerBreakdown: Record<string, number> = {};
    const costEstimate: Record<string, number> = {};
    let totalInputSize = 0;
    let totalOutputSize = 0;

    logs.forEach(log => {
      // Model breakdown
      modelBreakdown[log.selected_model] = (modelBreakdown[log.selected_model] || 0) + 1;

      // Provider breakdown
      providerBreakdown[log.provider] = (providerBreakdown[log.provider] || 0) + 1;

      // Cost breakdown
      costEstimate[log.estimated_cost] = (costEstimate[log.estimated_cost] || 0) + 1;

      // Size totals
      totalInputSize += log.input_size;
      totalOutputSize += log.actual_completion_tokens || log.expected_output_tokens;
    });

    return {
      totalRequests: logs.length,
      modelBreakdown,
      providerBreakdown,
      averageInputSize: logs.length > 0 ? Math.round(totalInputSize / logs.length) : 0,
      averageOutputSize: logs.length > 0 ? Math.round(totalOutputSize / logs.length) : 0,
      costEstimate
    };
  }

  /**
   * Get recent routing logs
   */
  public static getRecentLogs(limit: number = 50): AIRoutingLog[] {
    return this.inMemoryLogs.slice(-limit).reverse();
  }

  /**
   * Clear in-memory logs (for testing)
   */
  public static clearLogs(): void {
    this.inMemoryLogs = [];
  }

  /**
   * Export logs to JSON
   */
  public static exportLogs(): string {
    return JSON.stringify(this.inMemoryLogs, null, 2);
  }
}

// Optional: Database migration for persistent logging
export const AI_ROUTING_LOGS_TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_routing_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  request_type TEXT NOT NULL,
  selected_model TEXT NOT NULL,
  provider TEXT NOT NULL,
  routing_reason TEXT NOT NULL,
  input_size INTEGER NOT NULL,
  expected_output_tokens INTEGER NOT NULL,
  actual_prompt_tokens INTEGER,
  actual_completion_tokens INTEGER,
  actual_total_tokens INTEGER,
  estimated_cost TEXT NOT NULL,
  had_attachments BOOLEAN DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_routing_logs_user_id ON ai_routing_logs(user_id);
CREATE INDEX idx_ai_routing_logs_project_id ON ai_routing_logs(project_id);
CREATE INDEX idx_ai_routing_logs_timestamp ON ai_routing_logs(timestamp);
CREATE INDEX idx_ai_routing_logs_model ON ai_routing_logs(selected_model);
`;
