-- Sync transaction_type for existing user categories that match predefined ones
UPDATE categories c
SET transaction_type = pc.transaction_type
FROM predefined_categories pc
WHERE c.name = pc.name
  AND c.transaction_type IS NULL
  AND pc.transaction_type IS NOT NULL;

-- Insert new predefined categories for existing users who are missing them
INSERT INTO categories (user_id, name, normalized_name, is_predefined, transaction_type)
SELECT u.id, pc.name, normalize_string(pc.name), TRUE, pc.transaction_type
FROM users u
CROSS JOIN predefined_categories pc
WHERE pc.name IN ('Freela', 'Investimentos', 'Benefícios')
  AND NOT EXISTS (
    SELECT 1 FROM categories c
    WHERE c.user_id = u.id AND c.name = pc.name
  );
