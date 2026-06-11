# AI Media Generation Pipeline (map)

A map of how images and clips get generated: every UI entry point, the route it hits,
the prompt that gets built, and the model that runs it. Use this to see the whole system
at once and decide what to simplify. (Text/script generation is out of scope here; see
`.agents/docs/ai.md`.)

Last updated after the visual-style unification refactor (June 2026).

---

## 1. One-glance flow

```
UI action ─▶ frontend hook/modal ─▶ POST /api/ai/... ─▶ route handler
   ─▶ resolve project visual_style (source of truth)
   ─▶ build prompt (prompts/*.ts, shared style registry)
   ─▶ ImageModelRouter / videoModelRouter ─▶ provider (OpenRouter / Replicate)
   ─▶ download ─▶ Supabase storage (private) ─▶ DB path ─▶ signed URL back to UI
```

Two stages exist for most entities:
1. **Extraction** (text AI): script/brainstorm ─▶ structured records (characters, locations, panels).
2. **Image/video** (media AI): a record ─▶ a rendered asset.

---

## 2. Entry points (what connects to what)

| UI action | Frontend | Endpoint | Route handler | Prompt builder | Model |
|---|---|---|---|---|---|
| Storyboard: break a scene into panels | `useStoryboard.ts` | `POST /scene-to-storyboard` | `storyboards.ts:183` | `buildSceneToStoryboardPrompt` | text (grok via AIModelRouter) |
| Storyboard: render a panel image | `useStoryboard.generatePanelImage` | `POST /generate-storyboard-image` | `storyboards.ts:396` | `buildStoryboardImagePrompt` (+ `buildEnhancedSceneDescription`) | image |
| Characters: "Extraer con IA" | `CharactersView.tsx` | `POST /script-to-characters`, `/documents-to-characters` | `characters.ts:945 / :685` | `buildScriptToCharactersPrompt`, `buildDocumentsToCharactersPrompt` | text |
| Character: generate portrait | `CharacterImageGenerationModal.tsx` | `POST /generate-character-image` | `characters.ts:176` | `buildCharacterImagePrompt` | image |
| Character: extra angles (turnaround) | `CharacterViewDialog` | `POST /generate-character-views` | `characters.ts:527` | `buildCharacterViewPrompt` | image (klein, refs) |
| Locations: "Extraer con IA" | `LocationsView.tsx` | `POST /script-to-locations`, `/documents-to-locations` | `locations.ts:320 / :76` | `buildScriptToLocationsPrompt`, `buildDocumentsToLocationsPrompt` | text |
| Location: generate image | `LocationImageGenerationModal.tsx` | `POST /generate-location-image` | `locations.ts:594` | `buildLocationImagePrompt` | image |
| Video: animate a panel | `usePanelVideos.ts` | `POST /generate-panel-video`, `GET /panel-video-status` | `videos.ts:111 / :295` | `buildVideoMotionPrompt` | video |
| Video: stitch scene/episode reel | `usePanelVideos.ts` | `POST /render-scene`, `/render-episode` | `videos.ts:499 / :542` | none (ffmpeg `videoStitchService`) | none |

---

## 3. Visual style — single source of truth

The one place that defines "what a style looks like":

- **`prompts/shared.ts`** → `VISUAL_STYLE_PRESETS` (12 styles). Each = `{ anchor, reinforce, negative }`.
  - `resolveVisualStyleId(str)` normalizes any string (incl. legacy values) to a known id.
  - `buildStyleEnforcement(id)` returns the late `reinforce + Negative:` block.
  - `SUBJECT_FIDELITY` / `WARDROBE_FIDELITY` keep non-humans natural and stop role→wardrobe.
- **`services/projectStyleService.ts`** → `resolveEffectiveVisualStyle(supabase, projectId, override?)`. Every image route calls this. The project's `projects.visual_style` is the default; a per-request `image_style` is an optional override. **Backend, not the frontend, decides the style.**
- Frontend mirror: **`plotwell-app/src/types/visualStyle.ts`** (`VISUAL_STYLES` metadata). The project picker (`ProjectModal`) is the ONLY style control; character/location modals show it read-only.

The 12 ids: `cinematic, 3d-animation, anime, noir, watercolor, comic, concept-art, stop-motion, storybook, oil-painting, retro-film, cyberpunk`. DB CHECK constraint in `migrations/add_visual_style_to_projects.sql` must list all of them.

All three image builders (`buildStoryboardImagePrompt`, `buildCharacterImagePrompt`, `buildLocationImagePrompt`) consume this registry, so style enforcement is identical everywhere. They differ only in subject framing (panel vs portrait vs establishing shot).

---

## 4. Prompt catalog (media)

| Builder | File | Produces | Key inputs |
|---|---|---|---|
| `buildSceneToStoryboardPrompt` | storyboards.ts | JSON panel breakdown (shot/camera/lighting/mood/duration) | scene heading + content, panel count, video format |
| `buildStoryboardImagePrompt` | storyboards.ts | panel still prompt | scene desc, shot/camera/optics, lighting, mood, **styleId**, sketch fidelity branch |
| `buildEnhancedSceneDescription` | storyboards.ts | merges char/location/custom text into the scene desc | character + location descriptions |
| `buildCharacterImagePrompt` | characters.ts | portrait prompt | **appearance** (preferred) or description, elements, **styleId**, refs |
| `buildCharacterViewPrompt` | characters.ts | turnaround angle prompt | angle, identity-locked reference |
| `buildLocationImagePrompt` | locations.ts | location reference prompt | name/type, visual_notes + atmosphere, **styleId**, includePeople |
| `buildVideoMotionPrompt` | storyboards.ts | image-to-video motion prompt | scene desc, camera direction, mood, previous-shot continuity |
| `buildCharacterPromptDescription` / `buildLocationPromptDescription` | storyboards.ts | text fragments used to enrich storyboard panels | selected character/location fields |

Sanitization: `imageModelRouter.sanitizeForImageGeneration()` (DeepSeek V4 Flash) strips moderation triggers from free text before it enters an image prompt.

---

## 5. Data that feeds generation

- **Character** (`characters` table): `appearance` (concrete physical, preferred for images), `description` (personality/role, non-visual), `character_elements` (costume/prop refs), `image_url` (primary ref). Extraction now fills `appearance` and `description` separately.
- **Location** (`locations` table): `description`, `atmosphere`, `visual_notes`, `image_url`.
- **Storyboard panel** (`storyboard_panels`): `scene_description`, `shot_type`, `camera_movement`, `camera_direction`, `lighting`, `mood`, `notes`, `image_url`, `image_fidelity` (sketch|cinematic), and the `video_*` lifecycle columns.
- **Project**: `visual_style`, `video_format`, `project_type`.

References passed to the image model carry a role (`character` | `location` | `continuity`) so a face photo and a set photo are steered differently. See `imageModelRouter.generateWithOpenRouter`.

---

## 6. Models

- **Image** (`services/imageModelRouter.ts`): default `flux.2-pro` (OpenRouter), fallback `flux.2-klein-4b`; also `gemini-2.5-flash-image`, `riverflow-v2`. Replicate optional: `seedream-4`, `flux-1.1-pro`, `flux-2-dev`, `imagen-4-fast`.
- **Video** (`services/videoModelRouter.ts`): default `x-ai/grok-imagine-video`; also `bytedance/seedance-2.0-fast`, `bytedance/seedance-1-5-pro` (OpenRouter video API, async poll).
- **Text** (`services/aiModelRouter.ts`): default `deepseek/deepseek-v4-flash`; force options grok / gpt-5-mini / claude-sonnet.

Image cost: 10 credits/image (and 10 credits/second of video). Charged on success only.

---

## 7. Complexity audit (for simplification)

Honest read on what is load-bearing vs scaffolding, since the goal is to simplify.

**Earned by a real failure (removing it brings the bug back):**
- `appearance` vs `description` split — fixed vague characters + invented armor. This is clean DATA, not prompt cruft. Keep.
- A non-photoreal nudge for stylized looks — without it, 3D/anime locations rendered as real photos.

**Candidate scaffolding (test before trusting; newer models may not need it):**
- The full `anchor + reinforce + negative` triple per style. Modern models (Gemini 2.5 Flash Image, Seedream 4, FLUX.2) follow concise natural-language style instructions; long negative lists are an SD1.5-era habit and can confuse.
- The stacked per-panel rules (optics + lighting + mood + continuity + fidelity). Contradictions creep in (e.g. hardcoded "cinematic lighting" vs an anime style).

**Simplification experiment (implemented):** set `SIMPLE_IMAGE_PROMPTS=true` and restart the backend. The three image builders then emit SHORT prompts — style anchor + subject (+ the load-bearing subject/wardrobe fidelity for characters), dropping the reinforcement, negative lists, and stacked per-shot rules. Regenerate the same 4 cases (3D cat, 3D location, anime panel, noir panel) with the flag off vs on and compare. Keep each guard only if its failure returns with the flag on. Flag lives in `prompts/shared.ts` (`SIMPLE_IMAGE_PROMPTS`).
