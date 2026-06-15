-- Add created_at and updated_at columns to wizard_steps
ALTER TABLE wizard_steps ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE wizard_steps ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();

-- Create index for wizard_name + step_key lookups (used by callback handler)
CREATE INDEX idx_wizard_steps_name_key ON wizard_steps(wizard_name, step_key);

-- Set created_at for existing rows
UPDATE wizard_steps SET created_at = NOW() WHERE created_at IS NULL;
