// filepath: src/utils/replicateHelper.ts
import dotenv from "dotenv";

dotenv.config();

// Only log verbose AI details when explicitly enabled (local dev only)
const DEBUG_AI = process.env.DEBUG_AI === 'true';

const replicateApiToken = process.env.REPLICATE_API_TOKEN;

if (!replicateApiToken) {
  throw new Error("Missing Replicate API token");
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ReplicateCompletionOptions {
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
}

interface GPT5MiniOptions {
  messages: Message[];
  max_completion_tokens?: number;
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
  verbosity?: "low" | "medium" | "high";
}

interface ReplicateCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
}

export async function createReplicateCompletion(
  options: ReplicateCompletionOptions
): Promise<ReplicateCompletionResponse> {
  const {
    messages,
    max_tokens = 2048,
    temperature = 0.7,
    top_p = 1,
    presence_penalty = 0,
    frequency_penalty = 0
  } = options;

  // Build the full prompt from messages
  const systemMessage = messages.find(m => m.role === "system");
  const conversationMessages = messages.filter(m => m.role !== "system");

  const systemInstructions = systemMessage?.content || "";
  const conversationText = conversationMessages.map(msg => {
    const role = msg.role === "assistant" ? "Assistant" : "User";
    return `${role}: ${msg.content}`;
  }).join("\n\n");

  const fullPrompt = systemInstructions
    ? `${systemInstructions}\n\n${conversationText}`
    : conversationText;

  // Call Replicate API
  const replicateResponse = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${replicateApiToken}`,
      "Content-Type": "application/json",
      "Prefer": "wait"
    },
    body: JSON.stringify({
      version: "openai/gpt-oss-120b",
      input: {
        prompt: fullPrompt,
        max_tokens,
        temperature,
        top_p,
        presence_penalty,
        frequency_penalty
      }
    })
  });

  if (!replicateResponse.ok) {
    const errorText = await replicateResponse.text();
    console.error("Replicate API error:", errorText);
    throw new Error(`Replicate API error: ${replicateResponse.status}`);
  }

  const replicateData = await replicateResponse.json();

  // Extract the answer from Replicate response
  let answer = "";
  if (replicateData.output) {
    if (Array.isArray(replicateData.output)) {
      answer = replicateData.output.join("").trim();
    } else if (typeof replicateData.output === "string") {
      answer = replicateData.output.trim();
    }
  }

  // Estimate token usage (Replicate doesn't provide exact counts)
  const estimatedPromptTokens = Math.ceil(fullPrompt.length / 4);
  const estimatedCompletionTokens = Math.ceil(answer.length / 4);

  // Return in OpenAI-compatible format
  return {
    choices: [{
      message: {
        content: answer
      }
    }],
    usage: {
      prompt_tokens: estimatedPromptTokens,
      completion_tokens: estimatedCompletionTokens,
      total_tokens: estimatedPromptTokens + estimatedCompletionTokens
    },
    model: "gpt-oss-120b"
  };
}

/**
 * Create completion using GPT-5-mini model
 * Supports much larger outputs - suitable for document generation
 */
export async function createGPT5MiniCompletion(
  options: GPT5MiniOptions
): Promise<ReplicateCompletionResponse> {
  const {
    messages,
    max_completion_tokens,
    reasoning_effort = "medium",
    verbosity = "high"
  } = options;

  // Separate system message from conversation
  const systemMessage = messages.find(m => m.role === "system");
  const conversationMessages = messages.filter(m => m.role !== "system");

  // Format messages for GPT-5-mini API
  const formattedMessages = conversationMessages.map(msg => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content
  }));

  if (DEBUG_AI) {
    console.log(`🤖 GPT-5-mini Request: ${max_completion_tokens || 'default'} max tokens, reasoning: ${reasoning_effort}, verbosity: ${verbosity}`);
    console.log(`📝 System prompt length: ${systemMessage?.content?.length || 0} chars`);
    console.log(`📝 User message length: ${conversationMessages[0]?.content?.length || 0} chars`);
  }

  // Build request input - use prompt field with full conversation (don't use messages array)
  // According to the schema: "Text to send to model (omit if using messages)"
  // But the model seems to work better with prompt field for long content
  const fullPrompt = conversationMessages.map(m => m.content).join("\n\n");

  const requestInput: any = {
    system_prompt: systemMessage?.content || "",
    prompt: fullPrompt,
    reasoning_effort,
    verbosity,
    image_input: []
  };

  // Only add max_completion_tokens if specified
  if (max_completion_tokens) {
    requestInput.max_completion_tokens = max_completion_tokens;
  }

  if (DEBUG_AI) console.log(`📤 Sending request with prompt length: ${fullPrompt.length} chars`);

  // Call Replicate API with GPT-5-mini using model name endpoint (no version hash needed)
  const replicateResponse = await fetch("https://api.replicate.com/v1/models/openai/gpt-5-mini/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${replicateApiToken}`,
      "Content-Type": "application/json",
      "Prefer": "wait"
    },
    body: JSON.stringify({
      input: requestInput
    })
  });

  if (!replicateResponse.ok) {
    const errorText = await replicateResponse.text();
    console.error("❌ Replicate GPT-5-mini API error:", errorText);
    throw new Error(`Replicate GPT-5-mini API error: ${replicateResponse.status} - ${errorText}`);
  }

  const replicateData = await replicateResponse.json();

  if (DEBUG_AI) {
    console.log(`📦 Replicate response status: ${replicateData.status}`);
    console.log(`📦 Replicate response output type: ${typeof replicateData.output}`);
    if (Array.isArray(replicateData.output)) {
      console.log(`📦 Output array length: ${replicateData.output.length}`);
    }
  }

  // Extract the answer from Replicate response
  let answer = "";
  if (replicateData.output) {
    if (Array.isArray(replicateData.output)) {
      answer = replicateData.output.join("").trim();
    } else if (typeof replicateData.output === "string") {
      answer = replicateData.output.trim();
    }
  }

  // Log response info
  if (answer.length === 0) {
    console.error(`❌ GPT-5-mini returned EMPTY output!`);
    console.error(`Raw replicateData:`, JSON.stringify(replicateData, null, 2));
  } else if (DEBUG_AI) {
    console.log(`✅ GPT-5-mini Response: ${answer.length} characters received`);
  }

  // Estimate token usage (Replicate doesn't provide exact counts for GPT-5-mini yet)
  const fullPromptForEstimate = messages.map(m => m.content).join("\n\n");
  const estimatedPromptTokens = Math.ceil(fullPromptForEstimate.length / 4);
  const estimatedCompletionTokens = Math.ceil(answer.length / 4);

  // Return in OpenAI-compatible format
  return {
    choices: [{
      message: {
        content: answer
      }
    }],
    usage: {
      prompt_tokens: estimatedPromptTokens,
      completion_tokens: estimatedCompletionTokens,
      total_tokens: estimatedPromptTokens + estimatedCompletionTokens
    },
    model: "gpt-5-mini"
  };
}
