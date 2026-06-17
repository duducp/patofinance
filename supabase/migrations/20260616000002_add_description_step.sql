-- Add optional description step to gasto and receita wizards

-- Step 1: Shift existing steps out of the way (add 100 to avoid unique conflicts)
UPDATE wizard_steps SET step_order = step_order + 100
WHERE wizard_name IN ('gasto', 'receita') AND step_order >= 2;

-- Step 2: Shift back down (100+ original value → original+1)
UPDATE wizard_steps SET step_order = step_order - 99
WHERE wizard_name IN ('gasto', 'receita') AND step_order >= 102;

-- Step 3: Insert description step at the freed position
INSERT INTO wizard_steps (wizard_name, step_order, step_key, prompt, input_type, is_required) VALUES
  ('gasto', 2, 'description', 'Descrição (opcional)?\n\nEx: almoço no restaurante', 'text', FALSE),
  ('receita', 2, 'description', 'Descrição (opcional)?\n\nEx: pagamento do projeto', 'text', FALSE);
