-- Fix description step prompts that were inserted with literal \n instead of actual newlines
UPDATE wizard_steps SET prompt = E'Descrição (opcional)?\n\nEx: almoço no restaurante'
WHERE wizard_name = 'gasto' AND step_key = 'description' AND prompt = 'Descrição (opcional)?\n\nEx: almoço no restaurante';
UPDATE wizard_steps SET prompt = E'Descrição (opcional)?\n\nEx: pagamento do projeto'
WHERE wizard_name = 'receita' AND step_key = 'description' AND prompt = 'Descrição (opcional)?\n\nEx: pagamento do projeto';
