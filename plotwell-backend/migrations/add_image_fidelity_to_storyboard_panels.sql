-- Track which fidelity a storyboard panel's image was generated with.
--
-- The Animate (image-to-video) feature is only offered for cinematic (real,
-- colorful) stills — animating a black-and-white sketch produces poor video.
-- We need to remember the fidelity per panel because only the image itself was
-- previously stored.
--
-- Values: 'sketch' | 'cinematic'. NULL = unknown (uploaded/legacy) and is
-- treated as animatable; only an explicit 'sketch' blocks animation.

ALTER TABLE public.storyboard_panels
  ADD COLUMN IF NOT EXISTS image_fidelity TEXT;

ALTER TABLE public.storyboard_panels
  DROP CONSTRAINT IF EXISTS storyboard_panels_image_fidelity_check;

ALTER TABLE public.storyboard_panels
  ADD CONSTRAINT storyboard_panels_image_fidelity_check
  CHECK (image_fidelity IS NULL OR image_fidelity IN ('sketch', 'cinematic'));
