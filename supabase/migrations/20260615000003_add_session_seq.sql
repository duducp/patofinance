-- Add session_seq to wizard_states for callback session protection
ALTER TABLE wizard_states ADD COLUMN session_seq INTEGER NOT NULL DEFAULT 0;

GRANT ALL ON wizard_states TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
