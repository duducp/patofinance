-- Make predefined categories global (user_id = NULL) instead of per-user copies

-- 1. User-modified predefined categories that were renamed: remove is_predefined flag
UPDATE categories c
SET is_predefined = false
WHERE c.user_id IS NOT NULL
  AND c.is_predefined = true
  AND c.normalized_name IS NOT NULL
  AND c.normalized_name NOT IN (
    SELECT normalize_string(pc.name) FROM predefined_categories pc
  );

-- 2. Delete per-user copies of unchanged predefined categories
DELETE FROM categories c
WHERE c.user_id IS NOT NULL
  AND c.is_predefined = true
  AND c.normalized_name IS NOT NULL
  AND c.normalized_name IN (
    SELECT normalize_string(pc.name) FROM predefined_categories pc
  );

-- 3. Drop old unique constraint that doesn't handle NULL user_id
DROP INDEX IF EXISTS idx_categories_user_normalized;

-- 4. Insert system-level predefined categories
INSERT INTO categories (name, normalized_name, is_predefined, transaction_type, user_id)
SELECT
  pc.name,
  normalize_string(pc.name),
  true,
  pc.transaction_type,
  NULL
FROM predefined_categories pc
ON CONFLICT DO NOTHING;

-- 5. Partial unique index for user-owned categories
CREATE UNIQUE INDEX idx_categories_user_normalized
  ON categories(user_id, normalized_name)
  WHERE user_id IS NOT NULL;

-- 6. Partial unique index for system categories
CREATE UNIQUE INDEX idx_categories_system_normalized
  ON categories(normalized_name)
  WHERE user_id IS NULL;

-- 7. Update suggest_categories to include system categories
CREATE OR REPLACE FUNCTION suggest_categories(
  p_user_id BIGINT,
  p_query TEXT,
  p_limit INT DEFAULT 3,
  p_min_similarity REAL DEFAULT 0.3
) RETURNS TABLE(name TEXT, similarity REAL) AS $$
  SELECT c.name, similarity(c.normalized_name, normalize_string(p_query)) as sim
  FROM categories c
  WHERE (c.user_id = p_user_id OR c.user_id IS NULL)
    AND c.normalized_name % normalize_string(p_query)
    AND c.normalized_name <> normalize_string(p_query)
  ORDER BY c.user_id NULLS LAST, sim DESC
  LIMIT p_limit;
$$ LANGUAGE SQL STABLE;
