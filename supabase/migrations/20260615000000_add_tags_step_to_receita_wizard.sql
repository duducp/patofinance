-- Add tags step to receita wizard (step_order 5, after date)
INSERT INTO wizard_steps (wizard_name, step_order, step_key, prompt, input_type)
VALUES ('receita', 5, 'tags', 'Tags? (ex: #trabalho)', 'tags')
ON CONFLICT (wizard_name, step_order) DO NOTHING;
