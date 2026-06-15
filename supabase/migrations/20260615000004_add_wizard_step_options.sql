CREATE TABLE IF NOT EXISTS wizard_step_options (
  id SERIAL PRIMARY KEY,
  step_id INTEGER NOT NULL REFERENCES wizard_steps(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wizard_step_options_step_id ON wizard_step_options(step_id);

ALTER TABLE wizard_step_options ENABLE ROW LEVEL SECURITY;

GRANT ALL ON wizard_step_options TO service_role;
GRANT USAGE ON SEQUENCE wizard_step_options_id_seq TO service_role;
