# plotwell AI Service

**Last Updated**: April 5, 2026

---

## Overview

plotwell integrates AI-powered writing assistance across the platform: brainstorming chat, script/scene generation, character and location extraction, storyboard generation, document generation (treatments, synopses), beat sheet analysis, image generation for storyboards, characters, and locations, and autonomous multi-step screenplay writing via the Agent Writer.

---

## Architecture

### Key Files

| Layer | File | Purpose |
|-------|------|---------|
| **Router** | `routes/ai/index.ts` | Aggregates all AI sub-routers |
| **Chat** | `routes/ai/chat.ts` | Brainstorming chat with tool-use mode |
| **Scenes** | `routes/ai/scenes.ts` | Scene generation, discussion, insertion, transformation |
| **Characters** | `routes/ai/characters.ts` | Character extraction + image generation |
| **Locations** | `routes/ai/locations.ts` | Location extraction + image generation |
| **Storyboards** | `routes/ai/storyboards.ts` | Storyboard generation + image generation |
| **Documents** | `routes/ai/documents.ts` | Treatment, synopsis, outline generation |
| **Beats** | `routes/ai/beats.ts` | Beat suggestions, analysis, expansion |
| **Agent Writer** | `routes/ai/agent.ts` | Autonomous multi-step screenplay generation |
| **Task Events** | `routes/ai/taskEvents.ts` | SSE push notifications for AI task status |
| **Model Router** | `services/aiModelRouter.ts` | Text model selection + fallback chain |
| **Image Router** | `services/imageModelRouter.ts` | Image model selection + fallback chain |
| **Token Service** | `services/aiTokenService.ts` | Dynamic token limit calculation |
| **Context Optimizer** | `services/contextOptimizer.ts` | Context prioritization and budget allocation |
| **Chat Tools** | `services/chatToolDefinitions.ts` | Tool-use definitions for autonomous context fetching |
| **Agent Orchestrator** | `services/agentOrchestratorService.ts` | Multi-step plan/write/review/revise state machine |
| **Task Event Service** | `services/aiTaskEventService.ts` | In-process EventEmitter bus for AI task notifications |
| **Usage Tracker** | `services/aiUsageTracker.ts` | Usage event logging + monthly summaries |
| **Usage Middleware** | `middleware/aiUsageMiddleware.ts` | Request-level usage tracking |
| **AI Helpers** | `utils/aiHelpers.ts` | Language settings, text extraction, utilities |
| **Replicate Helper** | `utils/replicateHelper.ts` | Legacy Replicate API wrapper (GPT-OSS-120B) |
| **Routing Logger** | `services/aiRoutingLogger.ts` | Model routing decision analytics |
| **Script Doctor** | `services/scriptDoctorService.ts` | AI scene-level analysis with caching |
| **Doctor Prompts** | `services/scriptDoctorPrompts.ts` | Genre-aware, mode-specific analysis prompts |
| **Doctor Routes** | `routes/scriptDoctorV2.ts` | Script Doctor API endpoints |
| **AI Credits** | `routes/aiCredits.ts` | AI credit balance, purchase, fulfillment |
| **Scene Extractor** | `utils/sceneExtractor.ts` | Extract scenes by number/range from TipTap JSON |
| **Prompt System** | `prompts/index.ts` | Centralized prompt management (types, configs, builders) |
| **Agent Prompts** | `prompts/agent.ts` | Plan, write, review, revise prompts for Agent Writer |
| **Production Prompts** | `prompts/production.ts` | Shot list, budget optimization prompts |
| **Shared Prompts** | `prompts/shared.ts` | Reusable fragments (TipTap format, JSON requirements) |
| **Prompt Types** | `prompts/types.ts` | PromptConfig interface (model, temperature, maxTokens, version) |

---

## Model Routing (Text)

### Providers

| Provider | Model | Context Window | Output Limit | Cost (per 1M tokens) |
|----------|-------|---------------|-------------|---------------------|
| **xAI (default)** | `grok-4-1-fast-reasoning` | 2M | 131K | $0.20 / $0.50 |
| **xAI** | `grok-4-1` | 2M | 131K | higher |
| **OpenAI** | `gpt-5-mini` | 400K | 128K | $0.30 / $1.50 |
| **OpenRouter** | Various (DeepSeek, Claude Sonnet 4, etc.) | varies | varies | varies |

All three providers use OpenAI-compatible APIs.

### Fallback Chain

```
xAI direct -> xAI retry -> Grok via OpenRouter -> error
OpenAI/OpenRouter failure -> fallback to xAI Grok
```

### Force Override

Routes can force a specific model via `metadata.forceModel`:

| Value | Model | Provider |
|-------|-------|----------|
| `'grok'` | grok-4-1-fast-reasoning | xAI |
| `'grok-no-reasoning'` | grok-4.1-fast | OpenRouter |
| `'gpt-5-mini'` | gpt-5-mini | OpenAI |
| `'claude-sonnet'` | claude-sonnet-4 | OpenRouter |
| `'openrouter'` | configurable (default: mimo-v2-flash) | OpenRouter |
| `'auto'` | default routing | default |

### Singleton

`aiRouter` is a singleton instance of `AIModelRouter`. All routes use it via `aiRouter.executeCompletion(context, options)`.

---

## Routing Analytics

`AIRoutingLogger` logs every model selection decision for analytics and cost optimization.

- **Database logging**: Inserts into `ai_routing_logs` table (if Supabase is configured)
- **In-memory buffer**: Keeps last 1000 logs for quick access (ring buffer)
- **Fields tracked**: user_id, project_id, endpoint, request_type, selected_model, provider, routing_reason, input_size, expected/actual token counts, estimated_cost, had_attachments
- **Fire-and-forget**: Logging never blocks the AI response

---

## Replicate Helper (Legacy)

`utils/replicateHelper.ts` provides a direct wrapper around the Replicate API for the GPT-OSS-120B model. This is a legacy integration predating the unified `aiModelRouter`. New code should use `aiRouter.executeCompletion()` instead.

- `createReplicateCompletion(options)` -- sends messages to Replicate's chat endpoint
- `createGPT5MiniCompletion(options)` -- sends to GPT-5-Mini via OpenAI, with `max_completion_tokens` and `reasoning_effort` params
- Both return `ReplicateCompletionResponse` with `choices[].message.content` and `usage` fields

---

## Scene Extractor

`utils/sceneExtractor.ts` provides utility functions for extracting specific scenes from TipTap JSON content without loading the full script.

- `extractSceneByNumber(content, sceneNumber)` -- single scene by number
- `extractScenesByRange(content, start, end)` -- inclusive range
- `extractScenesByNumbers(content, numbers[])` -- specific scene numbers

Returns `SceneContent` objects with heading, content text, characters, location, timeOfDay, estimatedPages.

---

## Token Management

### Base Limits

| Operation | Min | Max | Notes |
|-----------|-----|-----|-------|
| suggest-next-line | 512 | 512 | Single line completion |
| chat | 512 | 8,192 | Scales with project content size |
| script-standard | 8,192 | 32,768 | Standard scripts |
| script-feature | 32,768 | 65,536 | Feature films (120+ pages) |
| script-epic | 65,536 | 98,304 | Epic features (200+ pages) |
| storyboard | 4,096 | 32,768 | Scales with scene count |
| scene/character/location extraction | 4,096 | 16,384 | Depends on source content |

### Dynamic Calculation

`AITokenService.calculateTokenLimits(context, projectContext)` dynamically adjusts limits based on:

- **Content size**: Word count of concept, script, or source material
- **Project complexity**: Number of characters, locations, scene headings
- **Project type**: Film vs series affects base allocation
- **Safety buffer**: 95% of model's max output capacity (`MODEL_SPECS.safetyBuffer = 0.95`)

Scale detection thresholds (concept word count):
- `< 200 words` -> short (0.7x multiplier)
- `800-2000 words` -> standard (1.0-1.5x)
- `2000-3000 words` -> feature (32K base)
- `3000-5000 words` -> large-feature (65K base)
- `> 5000 words` -> epic (98K base)

---

## Context Building

### `AITokenService.buildProjectContext(projectId, supabase, includeScript, includeDocuments)`

Fetches project data from the database:
- Project type and production script ID
- Documents (treatments, outlines, etc.)
- Production script content (if `includeScript` and `prod_script_id` is set)
- Characters (name, description, type, importance)
- Locations (name, description)

### Context Optimizer

`ContextOptimizer.optimizeContext()` allocates token budget across context components:

| Component | Max Budget Allocation | Priority |
|-----------|----------------------|----------|
| Concept/documents | 40% of remaining | Essential |
| Script (storyboard) | 60% of remaining | Essential |
| Script (other) | 20% of remaining | Supplementary |
| Characters | 30% of remaining | Important |
| Locations | 10% of remaining | Supplementary |
| Conversation history | 30% of remaining | Important |

Characters are sorted by importance (`main > ensemble > minor > background`), then by `importance_level` (5=highest). Locations sorted by importance (`primary > secondary > background`). Conversation history prioritizes recent messages.

When content exceeds budget, the optimizer truncates descriptions or drops lower-priority items entirely.

---

## Image Generation

### Providers & Models

| Model | Provider | Notes |
|-------|----------|-------|
| **flux.2-pro** (default) | OpenRouter | Primary high-quality image model |
| **flux.2-klein-4b** (fallback) | OpenRouter | Cheaper/faster fallback |
| gemini-2.5-flash-image | OpenRouter | Dual text+image output |
| riverflow-v2-standard-preview | OpenRouter | Alternative |
| flux-2-dev | Replicate | Supports up to 4 reference images |
| seedream-4 | Replicate | ByteDance, 2K output |
| flux-1.1-pro | Replicate | Single reference image support |
| imagen-4-fast | Replicate | Google, fast |

OpenRouter is the primary provider for image generation. Replicate models are optional provider choices only when a Replicate-backed `preferred_model` is explicitly selected.

### Fallback Chain

```
Preferred model (retry up to 2x with exponential backoff) -> fallback model (flux.2-klein-4b) -> error
```

Content moderation errors are not retried; a user-friendly message is returned.

### Aspect Ratios

Supported: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `4:5`, `5:4`, `3:2`, `2:3`

### Reference Images

Sent as base64 data URIs. OpenRouter prepends guidance to the prompt based on `referenceStrength` (0-1). Replicate models pass references via model-specific parameters (`input_images`, `image`).

### Prompt Sanitization

`sanitizeForImageGeneration()` uses Grok to strip content that could trigger moderation filters while preserving visual/physical details.

### Storyboard Convenience

`generateStoryboardImage()` builds cinematic prompts from scene description + shot type + camera movement. Supports `sketch` and `cinematic` fidelity modes.

---

## Video Generation

Storyboard panel videos are generated through OpenRouter's video API (`x-ai/grok-imagine-video`) in `services/videoModelRouter.ts`. The panel image is passed as the first frame, and `buildVideoMotionPrompt()` controls only motion, camera movement, and continuity so the video preserves the generated storyboard image.

## AI Routes

All routes are mounted at `/api/ai` and require authentication.

| Endpoint | File | Purpose |
|----------|------|---------|
| `POST /chat-script` | chat.ts | Brainstorming chat (toggle or tool-use mode) |
| `POST /generate-scene` | scenes.ts | Generate a scene from concept/context |
| `POST /discuss-scene` | scenes.ts | Discuss/get feedback on a scene |
| `POST /insert-scene` | scenes.ts | Insert generated scene into script |
| `POST /preview-scene-insertion` | scenes.ts | Preview scene insertion point |
| `POST /transform-scene` | scenes.ts | Transform/rewrite a scene |
| `POST /transform-text` | scenes.ts | Transform selected text |
| `POST /documents-to-characters` | characters.ts | Extract characters from documents |
| `POST /script-to-characters` | characters.ts | Extract characters from script |
| `POST /generate-character-image` | characters.ts | Generate character portrait |
| `POST /documents-to-locations` | locations.ts | Extract locations from documents |
| `POST /script-to-locations` | locations.ts | Extract locations from script |
| `POST /generate-location-image` | locations.ts | Generate location image |
| `POST /scene-to-storyboard` | storyboards.ts | Generate storyboard from scene |
| `POST /script-to-storyboard` | storyboards.ts | Generate storyboard from script |
| `POST /generate-storyboard-image` | storyboards.ts | Generate single storyboard panel image |
| `POST /brainstorming-to-document` | documents.ts | Generate document from brainstorming |
| `POST /enrich-document` | documents.ts | Enrich/expand existing document |
| `POST /generate-presentation-image` | documents.ts | Generate image for presentation |
| `POST /projects/:projectId/beats/ai-suggest-next` | beats.ts | Suggest next beats |
| `POST /projects/:projectId/beats/ai-analyze` | beats.ts | Analyze beat structure |
| `POST /projects/:projectId/beats/ai-expand` | beats.ts | Expand beat into outline |
| `POST /projects/:projectId/beats/ai-generate-description` | beats.ts | Generate beat description |
| `POST /agent/plan` | agent.ts | Generate a scene-by-scene plan (SSE stream) |
| `POST /agent/execute` | agent.ts | Execute an approved plan (SSE stream) |
| `POST /agent/cancel` | agent.ts | Cancel an in-progress agent execution |
| `POST /agent/insert` | agent.ts | Insert reviewed scenes into the script |
| `GET /task-events?token=JWT&project_id=ID` | taskEvents.ts | SSE stream for AI task push notifications |

---

## Middleware Chain

Standard middleware order for AI endpoints:

```
requireAuth -> extractUserId -> [preventDuplicate*] -> addPricingService
-> [fullRequestClassification] -> checkAIGenerationLimit -> trackAIUsage
-> addAIUsageTracker -> extractProjectId -> handler
```

| Middleware | Purpose |
|-----------|---------|
| `requireAuth` | JWT token validation |
| `extractUserId` | Sets `req.userId` from token |
| `preventDuplicate*` | In-memory dedup (per operation type) |
| `addPricingService` | Attaches pricing service to request |
| `fullRequestClassification` | Estimates complexity and token needs |
| `checkAIGenerationLimit` | Blocks if quota exceeded (free: 40 lifetime) |
| `trackAIUsage` | Increments generation counter |
| `addAIUsageTracker` | Creates tracker instance on request |
| `extractProjectId` | Sets `req.projectId` from body/params |

Image endpoints use `checkImageCredits` and `trackImageUsage` instead of the AI generation limit middleware.

---

## Chat Tool-Use Mode

When `useToolMode: true` is sent in the chat request, the AI autonomously fetches project context via function calling instead of relying on manual toggle flags.

### Available Tools

| Tool | Fetches |
|------|---------|
| `get_script` | Production script content (respects episode selection for TV series) |
| `get_characters` | Character profiles (name, role, type, age, description) |
| `get_locations` | Location details (name, type, description) |
| `get_beat_sheet` | Story structure beats (episode-aware for TV series) |
| `get_document` | Project documents by type (treatment, outline, synopsis, logline, notes) |

### Execution Loop

1. Send messages + tool definitions to model
2. If model requests tool calls, execute them and append results
3. Repeat up to **3 rounds** (force text-only response on final round)
4. Accumulate token usage across all rounds

### Free Tier Limits

- **Max 2 tool calls** per request (additional calls return upgrade message)
- **Max 2 context toggles** in manual mode

---

## Agent Writer

Autonomous multi-step screenplay generation feature. The user provides a high-level instruction (e.g., "Write Act 2 of my thriller"), and the agent plans scenes, writes them sequentially with continuity awareness, optionally reviews and revises each scene, then inserts them into the script.

### Architecture

- **Route**: `routes/ai/agent.ts` -- SSE endpoints for plan, execute, cancel, insert
- **Orchestrator**: `services/agentOrchestratorService.ts` -- stateful state machine
- **Prompts**: `prompts/agent.ts` -- plan, write, review, revise prompt configs and builders

### State Machine

```
idle -> planning -> awaiting_approval -> writing -> reviewing -> revising -> done
                                                                          -> cancelled
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ai/agent/plan` | POST | Generates a scene-by-scene plan from the user's instruction. Streams SSE events. Requires `agent_writer` feature. Deducts 1 AI creative task credit. |
| `/api/ai/agent/execute` | POST | Executes an approved plan. Writes each scene sequentially, optionally reviews (health score threshold) and revises. Streams SSE events per scene step. |
| `/api/ai/agent/cancel` | POST | Cancels an in-progress orchestrator for a given project. |
| `/api/ai/agent/insert` | POST | Inserts previously generated scenes (from review mode) into the script by appending TipTap nodes. |

### Execution Flow

1. **Plan** -- Gathers project context (characters, locations, beat sheet, outline, treatment, existing script) via chat tools, sends to planner model, returns structured plan with scenes.
2. **Execute** -- Iterates over plan scenes. For each scene:
   - Writes scene content (TipTap JSON) using continuity from previous scenes
   - Optionally reviews the scene (health score + issues + strengths)
   - If review score is below threshold (default 60), revises the scene
   - Deducts credits per step (write = 1 creative credit, review/revise = 1 each)
   - Optionally auto-inserts into the script
3. **Cancel** -- Sets abort signal, cleans up in-memory orchestrator registry.

### Concurrency

Only one orchestrator per user+project can run at a time. Active orchestrators are tracked in an in-memory `Map`. Client disconnects trigger automatic cancellation.

### SSE Events Emitted

Plan phase: `planning`, `plan_ready`, `error`
Execute phase: `heartbeat`, `scene_start`, `scene_written`, `scene_reviewed`, `scene_revised`, `scene_inserted`, `scene_complete`, `scene_failed`, `credits_update`, `execution_complete`, `error`

---

## AI Task Events (SSE Push Notifications)

Real-time push notification system replacing polling patterns. Clients open a single `EventSource` per project and receive events when background AI tasks complete or fail.

### Architecture

- **Route**: `routes/ai/taskEvents.ts` -- `GET /api/ai/task-events`
- **Service**: `services/aiTaskEventService.ts` -- in-process `EventEmitter` singleton

### Connection

```
GET /api/ai/task-events?token=JWT&project_id=UUID
```

Auth is via query param `token` (not headers) because `EventSource` does not support custom headers. The token is validated using the same JWT verification as `requireAuth`.

### Event Types

| Category | Events |
|----------|--------|
| Transforms | `transform:completed`, `transform:failed` |
| Scenes | `scene:completed`, `scene:failed` |
| Characters | `character:extracted`, `character:failed`, `character-image:completed`, `character-image:failed` |
| Locations | `location:extracted`, `location:failed`, `location-image:completed`, `location-image:failed` |
| Storyboards | `storyboard:completed`, `storyboard:failed`, `storyboard-image:completed`, `storyboard-image:failed` |
| Documents | `document:completed`, `document:failed` |
| Beats | `beat:completed`, `beat:failed` |
| Script Doctor | `script-doctor:completed`, `script-doctor:failed` |
| Agent Writer | `agent:step_complete`, `agent:done`, `agent:error` |

### Heartbeat

A `heartbeat` event with a timestamp is sent every 30 seconds to keep the connection alive.

### Usage (Backend)

```typescript
import { aiTaskEvents } from '../services/aiTaskEventService';

aiTaskEvents.emit('task', {
  type: 'scene:completed',
  projectId: '...',
  userId: '...',
  payload: { sceneId: '...' },
});
```

---

## Prompt Management System

Centralized prompt definitions in `src/prompts/`, organized by domain. Each module exports `PromptConfig` objects (model, temperature, maxTokens, version), system message constants, and builder functions for dynamic prompts.

### Files

| File | Domain |
|------|--------|
| `types.ts` | `PromptConfig` interface |
| `shared.ts` | Reusable fragments (TipTap format example, JSON requirements, scope restrictions) |
| `index.ts` | Re-exports all prompts for convenient imports |
| `chat.ts` | Brainstorming chat prompts |
| `scenes.ts` | Scene generation, discussion, transformation prompts |
| `characters.ts` | Character extraction prompts |
| `locations.ts` | Location extraction prompts |
| `storyboards.ts` | Storyboard generation prompts |
| `documents.ts` | Document generation prompts |
| `beats.ts` | Beat sheet analysis prompts |
| `agent.ts` | Agent Writer plan/write/review/revise prompts |
| `production.ts` | Production analysis prompts (shot lists, budget optimization) |

### PromptConfig

```typescript
interface PromptConfig {
  version: string;       // e.g., 'v1', 'v2-concise'
  model: string | null;  // Force model or null for default routing
  temperature: number;
  maxTokens: number;
  requestType: 'generation' | 'extraction' | 'chat';
}
```

---

## Usage Tracking

### Database Tables

| Table | Purpose |
|-------|---------|
| `ai_usage_events` | Text AI operations (tokens, model, duration, metadata) |
| `image_usage_events` | Image generations (provider, model, dimensions, prompt) |
| `monthly_ai_usage_summary` | Aggregated monthly counts per user |
| `user_quotas` | AI credits balance and generation counters |

### Tracking Flow

1. `addAIUsageTracker` middleware creates tracker instance
2. After AI call completes, route handler calls `trackOpenAIUsageInRoute()` or `trackImageUsageInRoute()`
3. Tracker inserts event into `ai_usage_events` or `image_usage_events`
4. Monthly summary is updated (upsert into `monthly_ai_usage_summary`)

Tracking is fire-and-forget (runs after response is sent via `setImmediate`). Failures are logged but never block the user response.

### AI Credits

- Free plan: 40 lifetime AI creative tasks (never resets)
- Pro plan: AI credit system (0 cost during launch offer, 1 credit per task after)
- Credits purchased separately, never expire
- Three pack sizes available (`small`, `large`, and `bulk`)

**Endpoints** (mounted at `/api/ai-credits`, requires auth):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/balance` | GET | Get current credit balance, effective costs, and purchase eligibility |
| `/purchase` | POST | Create Stripe checkout session for credit pack (body: `{ pack: 'small' \| 'large' \| 'bulk' }`) |
| `/fulfill` | POST | Verify Stripe payment and add credits (body: `{ session_id }`) |
| `/transactions` | GET | Credit transaction history (query: `?limit=N`) |
| `/config` | GET | Public config (pack sizes, costs, launch discount) -- no auth required |

---

## DEBUG_AI Logging

Controlled by `DEBUG_AI` environment variable.

```typescript
const DEBUG_AI = process.env.DEBUG_AI === 'true';
```

**Rules:**
- Verbose info logs: wrap with `if (DEBUG_AI)` check
- Errors (`console.error`): always unconditional
- Warnings (`console.warn`): always unconditional
- Never enable in production

Files using DEBUG_AI: `aiModelRouter.ts`, `imageModelRouter.ts`, `chatToolDefinitions.ts`, `contextOptimizer.ts`, `aiUsageTracker.ts`, `aiUsageMiddleware.ts`, `aiHelpers.ts`, `agentOrchestratorService.ts`, and all `routes/ai/*.ts` files.

---

## Language Support

### Configuration

Projects have `language` and `content_language` fields. `loadProjectLanguageSettings()` resolves with fallback chain: `project.content_language -> project.language -> user.ui_language -> 'en'`.

### Supported Languages (12)

English, Spanish, French, German, Italian, Portuguese, Russian, Japanese, Chinese, Hindi, Arabic, Korean.

### Behavior

- **Generation endpoints**: Output in `content_language` (the project's creative language)
- **Chat endpoints**: Reply in the language the user writes in, with content language taking priority
- `buildLanguageInstructions()` generates prompt instructions for the target language

---

## Common Gotchas

1. **`prod_script_id` must be set.** Script context requires the user to mark a script as the production version. If unset, tools and toggles return "No production script" messages.

2. **Chat token limits are low by design.** Brainstorming chat targets 700-1800 output tokens for conversational responses. The limits scale with attached context but are deliberately kept small to avoid verbose AI output.

3. **Tool-use mode skips toggle-based context.** When `useToolMode: true`, the manual context toggles (`includeScript`, `includeCharacters`, etc.) are ignored. The AI fetches what it needs via tools.

4. **Free tier has context limits.** Max 2 context toggles in manual mode, max 2 tool calls in tool-use mode. Exceeding returns a 403 with `error: 'context_limit_exceeded'`.

5. **Image sanitization uses a separate Grok call.** `sanitizeForImageGeneration()` makes an additional API call before image generation to strip moderation-triggering content. If `GROK_API_KEY` is missing, sanitization is skipped.

6. **GPT-5-Mini uses different API params.** `max_completion_tokens` instead of `max_tokens`, and temperature is fixed at 1 (deleted from params). The model router handles this automatically.

7. **Usage tracking never blocks responses.** All tracking runs in `setImmediate` callbacks after `res.json()`. If tracking fails, the user still gets their response.

8. **OpenRouter fallback loses reasoning tokens.** When xAI fails and falls back to `x-ai/grok-4.1-fast` via OpenRouter, the model has a lower output limit (30K vs 131K) and no reasoning capabilities.

---

## Environment Variables

```bash
# Text AI providers
GROK_API_KEY=xai-...           # xAI Grok (primary)
OPENAI_API_KEY=sk-...          # OpenAI GPT-5-Mini
OPENROUTER_API_KEY=sk-or-...   # OpenRouter (fallback + images)

# Image generation
REPLICATE_API_TOKEN=r8_...     # Replicate (image fallback)

# Logging
DEBUG_AI=true                  # Enable verbose AI logging (dev only)
```

---

## Script Doctor V2 Enhancements

### Issue Dismiss/Acknowledge

Users can dismiss or acknowledge individual Script Doctor issues.

**Table:** `script_doctor_dismissed_issues` (project_id, script_id, scene_id, issue_id, user_id, status)

**Endpoints** (in `routes/scriptDoctorV2.ts`):
- `GET /dismissed/:projectId/:scriptId` -- get all dismissed issue IDs
- `POST /dismiss-issue` -- dismiss or acknowledge (body: projectId, scriptId, sceneId, issueId, status)
- `DELETE /dismiss-issue` -- restore a dismissed issue

**Frontend:** IssueBubble has Dismiss/Acknowledge/Restore buttons. Dismissed issues are filtered from editor decorations.

### SSE Progress Streaming

`POST /analyze-batch-stream` streams progress events during analysis:
- `cache_check` -- how many scenes cached vs need analysis
- `context_gathering` -- AI gathering project context via tools
- `analyzing` -- AI generating analysis
- `parsing` -- parsing AI response
- `complete` -- final results

Frontend shows a progress bar with phase labels in the ScriptDoctorToolbar.

### Issues Panel

`IssuesPanel` SidePanel component lists all issues grouped by scene or category with:
- Filter by category, severity, dismissed status
- Click to scroll editor to issue location
- Inline dismiss/acknowledge per issue

### Scene Health Dots

Colored dots (green/yellow/orange/red) next to scene headings in the scene navigator dropdown, based on `healthScore`.
