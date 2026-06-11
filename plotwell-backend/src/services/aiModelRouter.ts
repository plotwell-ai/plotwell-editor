/**
 * AI Text Model Router
 *
 * Routes all text/LLM requests through a unified interface.
 * Supports three providers (all OpenAI-compatible):
 *
 *   OpenRouter (default): deepseek/deepseek-v4-flash | 64K context  | cheap & fast
 *   OpenAI:               gpt-5-mini                 | 400K context | $0.30/$1.50 per 1M
 *   xAI (legacy):         grok-4-1-fast-reasoning    | 2M context   | $0.20/$0.50 per 1M
 *
 * To switch the default, change DEFAULT_MODEL / DEFAULT_PROVIDER below.
 */

import { OpenAI } from "openai";

const DEBUG_AI = process.env.DEBUG_AI === 'true';

// ─── Default Configuration ──────────────────────────────────────────────────
// Change these to switch the global default for all text generation.

type TextProvider = 'xai' | 'openai' | 'openrouter';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_PROVIDER: TextProvider = 'openrouter';

/**
 * Strip leaked model tool-call control tokens (<|...|>, fullwidth ｜ / ▁
 * variants) from a complete text. These should arrive as structured tool_calls
 * but some providers emit them as plain text. Used on non-streaming responses;
 * the streaming path filters incrementally inside consumeStream.
 */
const stripControlTokens = (text: string): string =>
  text.replace(/<[｜|][^<>]*?[｜|]>/g, '');

// ─── Model Types ────────────────────────────────────────────────────────────

// Models available via OpenRouter proxy
export type OpenRouterModel =
  | 'deepseek/deepseek-v4-flash'
  | 'deepseek/deepseek-v3.2'
  | 'xiaomi/mimo-v2-flash'
  | 'x-ai/grok-4.1-fast'
  | 'anthropic/claude-sonnet-4';

type TextModelId = 'grok-4-1-fast-reasoning' | 'grok-4-1' | 'gpt-5-mini' | OpenRouterModel;

// Force-model options exposed to routes via metadata.forceModel
type ForceModelOption = 'grok' | 'grok-no-reasoning' | 'claude-sonnet' | 'gpt-5-mini' | 'openrouter' | 'auto';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface AIRoutingContext {
  requestType: 'chat' | 'generation' | 'extraction' | 'image';
  inputSize: {
    chars: number;
    estimatedTokens?: number;
    hasAttachments?: boolean;
    hasLargeContext?: boolean;
  };
  expectedOutput: {
    minTokens: number;
    maxTokens: number;
  };
  metadata?: {
    projectType?: string;
    contentScale?: 'short' | 'standard' | 'feature' | 'epic';
    forceModel?: ForceModelOption;
    openRouterModel?: OpenRouterModel;
    userPlanId?: string;
  };
}

export interface AIRoutingDecision {
  selectedModel: TextModelId;
  provider: TextProvider;
  reason: string;
  estimatedCost: 'low' | 'medium' | 'high';
  capabilities: {
    maxInputTokens: number;
    maxOutputTokens: number;
    supportsAttachments: boolean;
  };
}

export interface JSONSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, JSONSchema | { type: string; items?: JSONSchema; description?: string }>;
  items?: JSONSchema;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

export interface StructuredOutputFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    schema: JSONSchema;
    strict: boolean;
  };
}

export interface AICompletionOptions {
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: any[];
    tool_call_id?: string;
  }>;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  responseFormat?: StructuredOutputFormat;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }>;
}

export interface AICompletionResult {
  content: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
  provider: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  finishReason?: string;
}

export interface AIStreamingCallbacks {
  onToken: (token: string) => void;
  signal?: AbortSignal;
}

// ─── Model Capabilities ─────────────────────────────────────────────────────

const MODEL_CAPABILITIES: Record<string, AIRoutingDecision['capabilities']> = {
  'deepseek/deepseek-v4-flash':{ maxInputTokens: 163_840,  maxOutputTokens: 32_768,  supportsAttachments: false },
  'grok-4-1-fast-reasoning': { maxInputTokens: 2_000_000, maxOutputTokens: 131_072, supportsAttachments: true },
  'grok-4-1':                { maxInputTokens: 2_000_000, maxOutputTokens: 131_072, supportsAttachments: true },
  'gpt-5-mini':              { maxInputTokens: 400_000,   maxOutputTokens: 128_000, supportsAttachments: true },
  'deepseek/deepseek-v3.2':  { maxInputTokens: 163_840,   maxOutputTokens: 65_536,  supportsAttachments: false },
  'xiaomi/mimo-v2-flash':    { maxInputTokens: 262_144,   maxOutputTokens: 65_536,  supportsAttachments: false },
  'x-ai/grok-4.1-fast':     { maxInputTokens: 2_000_000, maxOutputTokens: 30_000,  supportsAttachments: true },
  'anthropic/claude-sonnet-4':{ maxInputTokens: 200_000,  maxOutputTokens: 64_000,  supportsAttachments: true },
};

function getCapabilities(model: string): AIRoutingDecision['capabilities'] {
  return MODEL_CAPABILITIES[model] || { maxInputTokens: 128_000, maxOutputTokens: 4096, supportsAttachments: false };
}

// ─── Router Class ───────────────────────────────────────────────────────────

export class AIModelRouter {
  private xai: OpenAI;
  private openai: OpenAI;
  private openrouter: OpenAI;

  constructor() {
    this.xai = new OpenAI({
      apiKey: process.env.GROK_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.openrouter = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.FRONTEND_URL?.split(',')[0] || "http://localhost:5173",
        "X-Title": "plotwell",
      },
    });
  }

  // ─── Routing ────────────────────────────────────────────────────────────

  public routeRequest(context: AIRoutingContext): AIRoutingDecision {
    const { metadata } = context;
    const tokens = context.inputSize.estimatedTokens || Math.ceil(context.inputSize.chars / 4);

    // Force overrides
    if (metadata?.forceModel && metadata.forceModel !== 'auto') {
      switch (metadata.forceModel) {
        case 'gpt-5-mini':
          return this.decision('gpt-5-mini', 'openai', 'Force: GPT-5-Mini', 'high');
        case 'openrouter':
          const m = metadata.openRouterModel || 'xiaomi/mimo-v2-flash';
          return this.decision(m, 'openrouter', `Force: OpenRouter (${m})`, 'medium');
        case 'grok-no-reasoning':
          return this.decision('x-ai/grok-4.1-fast', 'openrouter', 'Force: Grok via OpenRouter (no reasoning)', 'low');
        case 'claude-sonnet':
          return this.decision('anthropic/claude-sonnet-4', 'openrouter', 'Force: Claude Sonnet 4', 'medium');
        default: // 'grok'
          return this.decision('deepseek/deepseek-v4-flash', 'openrouter', 'Force: DeepSeek V4 Flash', 'low');
      }
    }

    // Default: route everything to the configured default
    return this.decision(
      DEFAULT_MODEL as TextModelId,
      DEFAULT_PROVIDER,
      `${context.requestType} (${tokens} tokens)`,
      'low'
    );
  }

  // ─── Execution ──────────────────────────────────────────────────────────

  public async executeCompletion(
    context: AIRoutingContext,
    options: AICompletionOptions
  ): Promise<AICompletionResult & { routingDecision: AIRoutingDecision }> {
    const decision = this.routeRequest(context);

    if (DEBUG_AI) {
      console.log(`🤖 AI ROUTER: ${decision.selectedModel} (${decision.provider}) - ${decision.reason}`);
    }

    switch (decision.provider) {
      case 'openai':  return this.callProvider(this.openai, decision, options);
      case 'openrouter': return this.callProvider(this.openrouter, decision, options);
      case 'xai': return this.callXai(decision, options);
    }
  }

  /**
   * Generic provider call (works for OpenAI and OpenRouter since both are OpenAI-compatible)
   */
  private async callProvider(
    client: OpenAI,
    decision: AIRoutingDecision,
    options: AICompletionOptions
  ): Promise<AICompletionResult & { routingDecision: AIRoutingDecision }> {
    try {
      if (DEBUG_AI) console.log(`🌐 ${decision.provider} API:`, { model: decision.selectedModel, maxTokens: options.maxTokens || 16384 });

      const params: any = {
        model: decision.selectedModel,
        messages: options.messages,
        max_tokens: options.maxTokens || 16384,
        temperature: options.temperature || 0.7,
      };
      if (decision.selectedModel === 'gpt-5-mini') {
        // GPT-5-mini uses max_completion_tokens, temperature fixed at 1
        params.max_completion_tokens = params.max_tokens;
        delete params.max_tokens;
        delete params.temperature;
      }
      if (options.responseFormat) params.response_format = options.responseFormat;
      if (options.tools?.length) params.tools = options.tools;

      const completion = await client.chat.completions.create(params);
      return this.toResult(completion, decision);
    } catch (error) {
      console.error(`❌ ${decision.provider} error (${decision.selectedModel}):`, error instanceof Error ? error.message : error);

      // Fallback to x-ai/grok-4.1-fast via OpenRouter if primary provider fails
      if (decision.provider !== 'openrouter' || decision.selectedModel !== 'x-ai/grok-4.1-fast') {
        console.warn('⚠️ Falling back to Grok via OpenRouter...');
        const fallback = this.decision('x-ai/grok-4.1-fast', 'openrouter', `Fallback: ${decision.provider} failed`, 'low');
        return this.callProvider(this.openrouter, fallback, options);
      }
      throw error;
    }
  }

  /**
   * xAI Grok with built-in retry + OpenRouter fallback
   */
  private async callXai(
    decision: AIRoutingDecision,
    options: AICompletionOptions
  ): Promise<AICompletionResult & { routingDecision: AIRoutingDecision }> {
    const modelId = decision.selectedModel === 'grok-4-1' ? 'grok-4-1' : 'grok-4-1-fast-reasoning';

    const buildParams = (): any => {
      const params: any = {
        model: modelId,
        messages: options.messages,
        max_tokens: options.maxTokens || 16384,
        temperature: options.temperature || 0.7,
      };
      if (options.responseFormat) params.response_format = options.responseFormat;
      if (options.tools?.length) params.tools = options.tools;
      return params;
    };

    // Attempt 1: xAI direct
    try {
      if (DEBUG_AI) console.log('🟣 xAI Grok:', { model: modelId, maxTokens: options.maxTokens || 16384 });
      const completion = await this.xai.chat.completions.create(buildParams());
      return this.toResult(completion, decision);
    } catch (err1) {
      console.warn('⚠️ xAI attempt 1 failed:', err1 instanceof Error ? err1.message : err1);
    }

    // Attempt 2: xAI retry
    try {
      if (DEBUG_AI) console.log('🔄 Retrying xAI Grok (attempt 2)...');
      const completion = await this.xai.chat.completions.create(buildParams());
      if (DEBUG_AI) console.log('✅ xAI retry succeeded');
      return this.toResult(completion, decision);
    } catch (err2) {
      console.warn('⚠️ xAI attempt 2 failed:', err2 instanceof Error ? err2.message : err2);
    }

    // Attempt 3: same model via OpenRouter
    console.warn('⚠️ Falling back to Grok via OpenRouter...');
    const fallback = this.decision('x-ai/grok-4.1-fast', 'openrouter', 'Fallback: xAI direct failed', 'low');
    return this.callProvider(this.openrouter, fallback, options);
  }

  // ─── Streaming Execution ───────────────────────────────────────────────

  /**
   * Execute a streaming completion. Tokens are emitted via callbacks.onToken.
   * Tool calls are accumulated and returned in the result (not streamed as text).
   */
  public async executeStreamingCompletion(
    context: AIRoutingContext,
    options: AICompletionOptions,
    callbacks: AIStreamingCallbacks
  ): Promise<AICompletionResult & { routingDecision: AIRoutingDecision }> {
    const decision = this.routeRequest(context);

    if (DEBUG_AI) {
      console.log(`🤖 AI ROUTER (stream): ${decision.selectedModel} (${decision.provider}) - ${decision.reason}`);
    }

    switch (decision.provider) {
      case 'openai':  return this.callProviderStreaming(this.openai, decision, options, callbacks);
      case 'openrouter': return this.callProviderStreaming(this.openrouter, decision, options, callbacks);
      case 'xai': return this.callXaiStreaming(decision, options, callbacks);
    }
  }

  private async callProviderStreaming(
    client: OpenAI,
    decision: AIRoutingDecision,
    options: AICompletionOptions,
    callbacks: AIStreamingCallbacks
  ): Promise<AICompletionResult & { routingDecision: AIRoutingDecision }> {
    try {
      const params: any = {
        model: decision.selectedModel,
        messages: options.messages,
        max_tokens: options.maxTokens || 16384,
        temperature: options.temperature || 0.7,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (decision.selectedModel === 'gpt-5-mini') {
        params.max_completion_tokens = params.max_tokens;
        delete params.max_tokens;
        delete params.temperature;
      }
      if (options.responseFormat) params.response_format = options.responseFormat;
      if (options.tools?.length) params.tools = options.tools;

      return await this.consumeStream(
        client.chat.completions.create(params),
        decision, callbacks
      );
    } catch (error) {
      console.error(`❌ ${decision.provider} streaming error (${decision.selectedModel}):`, error instanceof Error ? error.message : error);

      // Fallback to x-ai/grok-4.1-fast via OpenRouter if primary provider fails
      if (decision.provider !== 'openrouter' || decision.selectedModel !== 'x-ai/grok-4.1-fast') {
        console.warn('⚠️ Falling back to Grok via OpenRouter (streaming)...');
        const fallback = this.decision('x-ai/grok-4.1-fast', 'openrouter', `Fallback: ${decision.provider} streaming failed`, 'low');
        return this.callProviderStreaming(this.openrouter, fallback, options, callbacks);
      }
      throw error;
    }
  }

  private async callXaiStreaming(
    decision: AIRoutingDecision,
    options: AICompletionOptions,
    callbacks: AIStreamingCallbacks
  ): Promise<AICompletionResult & { routingDecision: AIRoutingDecision }> {
    const modelId = decision.selectedModel === 'grok-4-1' ? 'grok-4-1' : 'grok-4-1-fast-reasoning';

    const buildParams = (): any => {
      const params: any = {
        model: modelId,
        messages: options.messages,
        max_tokens: options.maxTokens || 16384,
        temperature: options.temperature || 0.7,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (options.responseFormat) params.response_format = options.responseFormat;
      if (options.tools?.length) params.tools = options.tools;
      return params;
    };

    // Attempt 1: xAI direct
    try {
      if (DEBUG_AI) console.log('🟣 xAI Grok (stream):', { model: modelId, maxTokens: options.maxTokens || 16384 });
      return await this.consumeStream(
        this.xai.chat.completions.create(buildParams()),
        decision, callbacks
      );
    } catch (err1) {
      console.warn('⚠️ xAI streaming attempt 1 failed:', err1 instanceof Error ? err1.message : err1);
    }

    // Attempt 2: xAI retry
    try {
      if (DEBUG_AI) console.log('🔄 Retrying xAI Grok streaming (attempt 2)...');
      return await this.consumeStream(
        this.xai.chat.completions.create(buildParams()),
        decision, callbacks
      );
    } catch (err2) {
      console.warn('⚠️ xAI streaming attempt 2 failed:', err2 instanceof Error ? err2.message : err2);
    }

    // Attempt 3: OpenRouter fallback
    console.warn('⚠️ Falling back to Grok via OpenRouter (streaming)...');
    const fallback = this.decision('x-ai/grok-4.1-fast', 'openrouter', 'Fallback: xAI direct streaming failed', 'low');
    return this.callProviderStreaming(this.openrouter, fallback, options, callbacks);
  }

  /**
   * Consume an OpenAI streaming response, emitting tokens via callback
   * and accumulating tool calls.
   */
  private async consumeStream(
    streamPromise: any,
    decision: AIRoutingDecision,
    callbacks: AIStreamingCallbacks
  ): Promise<AICompletionResult & { routingDecision: AIRoutingDecision }> {
    const stream = await streamPromise;
    let content = '';
    let finishReason = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    // Accumulate tool call deltas: index -> { id, name, arguments }
    const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();

    // Some models (e.g. DeepSeek via OpenRouter) leak their tool-call control
    // tokens (<|...|>, fullwidth ｜ / ▁ variants) into the text stream instead
    // of returning them as structured tool_calls. Strip them so they never
    // reach the user or get saved into the conversation. Buffered, because a
    // marker can be split across chunks.
    const CONTROL_TOKEN = /<[｜|][^<>]*?[｜|]>/g;
    const PARTIAL_TAIL = /<[｜|][^<>]*$|<$/; // possible start of a marker, held back
    let pending = '';
    const filterContent = (incoming: string): string => {
      pending = (pending + incoming).replace(CONTROL_TOKEN, '');
      const m = pending.match(PARTIAL_TAIL);
      if (m && m.index !== undefined) {
        const emit = pending.slice(0, m.index);
        pending = pending.slice(m.index);
        return emit;
      }
      const emit = pending;
      pending = '';
      return emit;
    };
    const flushContent = (): string => {
      // Drop any unterminated control-token prefix; keep everything else.
      const tail = pending.replace(CONTROL_TOKEN, '').replace(/<[｜|][^<>]*$/, '');
      pending = '';
      return tail;
    };

    try {
      for await (const chunk of stream) {
        // Check abort signal
        if (callbacks.signal?.aborted) {
          stream.controller?.abort?.();
          break;
        }

        const delta = chunk.choices?.[0]?.delta;
        const chunkFinish = chunk.choices?.[0]?.finish_reason;

        // Text content (filtered for leaked control tokens)
        if (delta?.content) {
          const clean = filterContent(delta.content);
          if (clean) {
            content += clean;
            callbacks.onToken(clean);
          }
        }

        // Tool call deltas
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccumulator.has(idx)) {
              toolCallAccumulator.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
            }
            const acc = toolCallAccumulator.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }

        if (chunkFinish) finishReason = chunkFinish;

        // Usage comes in the final chunk (with stream_options.include_usage)
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens || 0,
            completion_tokens: chunk.usage.completion_tokens || 0,
            total_tokens: chunk.usage.total_tokens || 0,
          };
        }
      }

      // Emit any text held back by the control-token filter
      const tail = flushContent();
      if (tail) {
        content += tail;
        callbacks.onToken(tail);
      }
    } catch (error) {
      // If aborted, treat as normal completion with partial content
      if (callbacks.signal?.aborted) {
        if (DEBUG_AI) console.log('🛑 Stream aborted by client');
      } else {
        throw error;
      }
    }

    // Convert accumulated tool calls to result format
    const toolCalls = toolCallAccumulator.size > 0
      ? Array.from(toolCallAccumulator.values()).map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }))
      : undefined;

    if (DEBUG_AI) console.log(`✅ ${decision.provider} streaming response:`, { usage, finishReason, toolCallCount: toolCalls?.length || 0 });

    return {
      content,
      usage,
      model: decision.selectedModel,
      provider: decision.provider,
      routingDecision: decision,
      toolCalls,
      finishReason,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private toResult(
    completion: OpenAI.Chat.ChatCompletion,
    decision: AIRoutingDecision
  ): AICompletionResult & { routingDecision: AIRoutingDecision } {
    const message = completion.choices[0].message;
    const usage = completion.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    if (DEBUG_AI) console.log(`✅ ${decision.provider} response:`, { usage, finishReason: completion.choices[0].finish_reason });

    return {
      content: stripControlTokens(message.content || ''),
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      },
      model: decision.selectedModel,
      provider: decision.provider,
      routingDecision: decision,
      toolCalls: message.tool_calls as any || undefined,
      finishReason: completion.choices[0].finish_reason,
    };
  }

  private decision(
    model: TextModelId,
    provider: TextProvider,
    reason: string,
    cost: 'low' | 'medium' | 'high'
  ): AIRoutingDecision {
    return {
      selectedModel: model,
      provider,
      reason,
      estimatedCost: cost,
      capabilities: getCapabilities(model),
    };
  }

  // ─── Static Utilities ─────────────────────────────────────────────────

  public static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  public static createContext(params: {
    requestType: AIRoutingContext['requestType'];
    inputText: string;
    expectedOutputTokens?: number;
    hasAttachments?: boolean;
    metadata?: AIRoutingContext['metadata'];
  }): AIRoutingContext {
    const chars = params.inputText.length;
    return {
      requestType: params.requestType,
      inputSize: {
        chars,
        estimatedTokens: AIModelRouter.estimateTokens(params.inputText),
        hasAttachments: params.hasAttachments || false,
        hasLargeContext: chars > 50_000,
      },
      expectedOutput: {
        minTokens: 100,
        maxTokens: params.expectedOutputTokens || 2048,
      },
      metadata: params.metadata,
    };
  }
}

// Singleton
export const aiRouter = new AIModelRouter();
