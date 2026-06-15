-- Create wizard_steps table
CREATE TABLE wizard_steps (
  id BIGSERIAL PRIMARY KEY,
  wizard_name TEXT NOT NULL,
  step_order INT NOT NULL,
  step_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  input_type TEXT NOT NULL CHECK (input_type IN ('text', 'select', 'date', 'tags')),
  options_source TEXT,
  is_required BOOLEAN DEFAULT TRUE,
  UNIQUE(wizard_name, step_order)
);

-- Insert default steps for 'gasto' wizard
INSERT INTO wizard_steps (wizard_name, step_order, step_key, prompt, input_type, options_source) VALUES
  ('gasto', 1, 'amount', 'Qual o valor?', 'text', NULL),
  ('gasto', 2, 'category', 'Qual categoria?', 'select', 'categories'),
  ('gasto', 3, 'group', 'Qual grupo?', 'select', 'groups'),
  ('gasto', 4, 'date', 'Qual data?', 'date', NULL),
  ('gasto', 5, 'tags', 'Tags? (ex: #trabalho)', 'tags', NULL);

-- Insert default steps for 'receita' wizard
INSERT INTO wizard_steps (wizard_name, step_order, step_key, prompt, input_type, options_source) VALUES
  ('receita', 1, 'amount', 'Qual o valor?', 'text', NULL),
  ('receita', 2, 'category', 'Qual categoria?', 'select', 'categories'),
  ('receita', 3, 'group', 'Qual grupo?', 'select', 'groups'),
  ('receita', 4, 'date', 'Qual data?', 'date', NULL);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON wizard_steps TO service_role;
GRANT USAGE, SELECT ON SEQUENCE wizard_steps_id_seq TO service_role;
