-- Explicit per-shot camera direction for each storyboard panel (shot).
--
-- camera_movement is a coarse enum (e.g. 'dolly-in'); camera_direction is one
-- concrete sentence describing how the camera actually moves in THIS shot —
-- where it starts, how it moves, the speed, and where it ends. The shot
-- breakdown AI writes it, and it drives the image-to-video animation so the
-- generated clip follows the intended camera move instead of guessing from the
-- enum alone.
--
-- NULL/'' for legacy panels — the video prompt falls back to the enum lookup.

ALTER TABLE public.storyboard_panels
  ADD COLUMN IF NOT EXISTS camera_direction TEXT DEFAULT '';

-- Supabase/PostgREST can keep a stale schema cache briefly after new columns.
NOTIFY pgrst, 'reload schema';
