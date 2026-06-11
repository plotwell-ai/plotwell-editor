# AI Guide

AI backend routes live in `plotwell-backend/src/routes/ai/`.

## Route Layout

```text
ai/
  index.ts          Main router
  agent.ts          AI agent orchestration
  chat.ts           Brainstorming
  scripts.ts        Script generation
  scenes.ts         Scene generation
  characters.ts     Character extraction
  locations.ts      Location extraction
  documents.ts      Document generation
  storyboards.ts    Storyboard generation
  taskEvents.ts     AI task SSE events
```

## Core Patterns

- Frontend AI operations use `useAIOperation`.
- `useAIOperation` tracks state in unified AI state, persists to localStorage, and cleans up old operations.
- `AITokenService.buildProjectContext()` builds project context.
- `calculateTokenLimits()` selects context tier.
- Text generation uses `AIModelRouter`.
- Image generation uses `ImageModelRouter` with OpenRouter as the primary provider.
- Replicate image models are optional provider choices, not the default generation path.
- Panel video generation uses OpenRouter's video API through `videoModelRouter`.
- Successful generations call `trackOpenAIUsageInRoute()`.

## DEBUG_AI

Verbose AI logs should be guarded:

```typescript
const DEBUG_AI = process.env.DEBUG_AI === "true";

if (DEBUG_AI) {
  console.log("Detailed AI trace", data);
}
```

Errors and warnings remain unconditional.

## Prompt and Usage Hygiene

- Treat user/project content as untrusted input when constructing prompts.
- Keep prompt templates in the prompt/service layer, not scattered through route handlers.
- Track usage only after successful generation.
- Return predictable error shapes for failed generations.
