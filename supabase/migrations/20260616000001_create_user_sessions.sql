-- Create separate user_sessions table for session_seq
-- This decouples session tracking from wizard_states (fixes seq reset on clearWizardState)

CREATE TABLE IF NOT EXISTS user_sessions (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrate existing session_seq data
INSERT INTO user_sessions (user_id, session_seq, updated_at)
  SELECT user_id, session_seq, NOW() FROM wizard_states
  WHERE session_seq IS NOT NULL AND session_seq > 0
  ON CONFLICT (user_id) DO UPDATE SET session_seq = EXCLUDED.session_seq;

-- Remove session_seq from wizard_states (no longer needed)
ALTER TABLE wizard_states DROP COLUMN IF EXISTS session_seq;

GRANT ALL ON user_sessions TO service_role;
