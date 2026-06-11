# Media Storage & Cost (Images + Video)

**Last Updated**: June 3, 2026 | **Status**: Documented for the future, not yet implemented

This doc captures (a) the proposed follow-up work for the visual production pipeline
and (b) the Supabase storage / network cost analysis and the mitigations we should
apply once media volume grows. None of section 3 or 4 is implemented yet. They are
recorded here so we do not lose the plan.

---

## 1. Context: what already shipped

The visual production pipeline (script to vertical video) was hardened in June 2026:

- **Reference roles**: character reference photos drive identity (exact face), location
  reference photos drive the set/environment. Previously every reference got a
  face-identity instruction, so the location photo was told to reproduce a face.
  See `referenceRoles` in `plotwell-backend/src/services/imageModelRouter.ts`.
- **`camera_direction`**: an explicit per-shot camera move is written during the shot
  breakdown, stored on `storyboard_panels`, and fed into the image-to-video motion
  prompt so the clip follows the intended move. Migration:
  `plotwell-backend/migrations/add_camera_direction_to_storyboard_panels.sql`.
- **Cinematic-first**: cinematic is the default and primary fidelity; sketch is secondary.
- **Character views endpoint** (backend only): `POST /api/ai/generate-character-views`
  generates identity-locked turnaround angles from a character's primary image, on the
  cheap fallback model `flux.2-klein-4b` (no escalation) at 100% reference strength.

---

## 2. Proposed follow-up work (visual pipeline)

Not implemented. Priority order:

1. **Wire the character-views UI.** Add a "Generate views" action in the character
   gallery that calls `POST /api/ai/generate-character-views`. The frontend must send
   `ai_credits_required = views * 10` so the upfront credit balance check is correct
   (the route sets `req.aiCreditsRequired` to the count actually produced, so failed
   views are not charged).
2. **Feed character views into storyboard image generation.** Today the storyboard
   image route uses only `character.image_url` (the single primary) as a reference.
   It should also pull the character's gallery `reference` images (the turnaround
   views) and pass them as additional character references, within the 3-image
   reference cap, so multi-angle coverage improves face consistency across shots.
3. **Seed locking across a scene's panels** for visual consistency. The video router
   already accepts `seed`; the image path does not thread one through. Lock a per-scene
   seed so panels of the same scene render consistently.
4. **One-click episode orchestration.** Breakdown -> images -> clips -> stitch is four
   manual steps. A single orchestrated flow would complete the "build the whole vertical
   content" goal.

---

## 3. Supabase cost model

Two distinct costs: **storage** (what you keep) and **egress / bandwidth** (every time
someone downloads or views a file). Egress is the one that scales badly with video.

**Supabase Pro pricing (verify in the dashboard, prices change):**

| Resource | Included (Pro $25/mo) | Overage |
|---|---|---|
| File storage | 100 GB | ~$0.021 / GB / month |
| Egress (bandwidth) | 250 GB | ~$0.09 / GB |

**Rough current file sizes:**

| Asset | Format today | Approx size |
|---|---|---|
| Storyboard panel image | PNG | 2 to 4 MB |
| Character / location image | PNG | 1 to 2 MB |
| Panel clip (5s, 720p) | MP4 | 3 to 6 MB |
| Stitched reel (~40s) | MP4 | 20 to 40 MB |

**Key takeaways:**

- **Storage is cheap.** Even 500 GB of media is ~$8/month over the included amount.
  Not the problem.
- **Egress is the real cost** because it is billed per view. A scene with 6 panels
  (image ~2.5 MB) plus 6 clips (~4 MB) is ~39 MB per load. 1,000 loads/day is
  ~1.2 TB/month, roughly ~920 GB over the included 250 GB, about **~$83/month**.
  Video dominates.

Formula: `egress_cost = (total_views * avg_file_size_GB - 250) * $0.09`

Note: Supabase bills total egress including traffic served through its CDN, so CDN
caching does not lower the bill. Only avoiding re-downloads by the same browser
(via `Cache-Control`) reduces billed egress.

This is **separate** from AI generation cost (OpenRouter FLUX / Grok Imagine,
Replicate), which is COGS against the AI credits users buy (10 credits/image,
10 credits/sec of video). That is usually the larger line item.

---

## 4. Mitigations (ranked by impact)

1. **Stop storing PNG.** Storyboard, character, and location images upload as
   `image/png` (often 2 to 4 MB). Transcode to WebP/JPEG q80 with `sharp` on upload to
   cut storage and per-view egress by 60 to 80%. Lowest effort, biggest win, fully in
   our control. Touch points: the `.upload(..., { contentType: 'image/png' })` calls in
   `routes/ai/storyboards.ts`, `routes/ai/characters.ts`, `routes/ai/locations.ts`.
2. **Right-size resolution.** 9:16 mobile reels do not need oversized frames. Generate
   and serve at the target resolution, not maximum.
3. **Browser caching.** Set a long `Cache-Control` on uploaded objects so a returning
   user does not re-download. (Reduces billed egress; CDN caching alone does not.)
4. **Offload video to Cloudflare R2** (or Bunny / Cloudflare Stream). R2 is ~$0.015/GB
   storage and **$0 egress**. Once video egress dominates, this is the standard move:
   keep images on Supabase, push the `generated-video` bucket (clips + reels) to R2.
   This removes the single largest cost line. Break-even worth calculating once we have
   real view volume.
5. **Lifecycle cleanup.** We already delete prior renders and clear orphaned panel
   videos when an image changes. Keep enforcing this and purge failed jobs.

---

## 5. Decision needed before implementing

To size this properly and find the R2 break-even point, we need expected volume:
projects/month, panels per project, and how often reels get watched. Until then the
cheapest immediate win (item 4.1, WebP transcode) can be done independently of any
volume estimate.
