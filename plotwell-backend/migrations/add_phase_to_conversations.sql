-- Add a `phase` column to conversations so Studio conversations are scoped to the
-- phase they were created in ('develop' | 'write' | 'plan').
--
-- Why: phase scoping previously lived only in the client (a per-phase localStorage
-- key). A stale conversationId could leak across phases, causing e.g. a Develop
-- conversation to be restored in Write mode. Tagging the row at the source lets the
-- client validate the restored conversation's phase and discard mismatches.
--
-- Legacy rows keep phase = NULL; clients treat NULL as 'develop' (the original mode).

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS phase TEXT;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_phase_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_phase_check
  CHECK (phase IN ('develop', 'write', 'plan'));

CREATE INDEX IF NOT EXISTS idx_conversations_project_phase
  ON public.conversations (project_id, phase);
