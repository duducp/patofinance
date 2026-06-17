-- Add optional description step to gasto and receita wizards

-- Shift existing steps to make room for description at step_order 2
UPDATE wizard_steps SET step_order = step_order + 1
WHERE wizard_name IN ('gasto', 'receita') AND step_order >= 2;

-- Insert description step (optional, text input)
INSERT INTO wizard_steps (wizard_name, step_order, step_key, prompt, input_type, is_required) VALUES
  ('gasto', 2, 'description', 'Descrição (opcional)?\n\nEx: almoço no restaurante', 'text', FALSE),
  ('receita', 2, 'description', 'Descrição (opcional)?\n\nEx: pagamento do projeto', 'text', FALSE);
