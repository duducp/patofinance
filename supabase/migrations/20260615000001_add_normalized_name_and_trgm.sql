-- Enable pg_trgm extension for fuzzy string matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Normalize string: lowercase, remove accents, remove non-alphanumeric
CREATE OR REPLACE FUNCTION normalize_string(s TEXT) RETURNS TEXT AS $$
BEGIN
  s := LOWER(s);
  s := TRANSLATE(s,
    'áàâãäåéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
    'aaaaaaaaeeeeeeeeiiiioooooouuuuucnAAAAAAAAEEEEEEEEIIIIIOOOOOOUUUUUCUN');
  s := REGEXP_REPLACE(s, '[^a-z0-9]', '', 'g');
  RETURN s;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- ===================== CATEGORIES =====================

-- Add normalized_name column (nullable initially to populate existing data)
ALTER TABLE categories ADD COLUMN normalized_name TEXT;

-- Populate from existing names
UPDATE categories SET normalized_name = normalize_string(name) WHERE normalized_name IS NULL;

-- Make it NOT NULL going forward
ALTER TABLE categories ALTER COLUMN normalized_name SET NOT NULL;

-- Unique constraint on (user_id, normalized_name) to prevent duplicates
CREATE UNIQUE INDEX idx_categories_user_normalized ON categories(user_id, normalized_name);

-- GIN trgm index for fast similarity searches
CREATE INDEX idx_categories_normalized_trgm ON categories USING gin (normalized_name gin_trgm_ops);

-- ===================== GROUPS =====================

-- Add normalized_name column (nullable initially to populate existing data)
ALTER TABLE groups ADD COLUMN normalized_name TEXT;

-- Populate from existing names
UPDATE groups SET normalized_name = normalize_string(name) WHERE normalized_name IS NULL;

-- Make it NOT NULL going forward
ALTER TABLE groups ALTER COLUMN normalized_name SET NOT NULL;

-- Unique constraint on (user_id, normalized_name) to prevent duplicates
CREATE UNIQUE INDEX idx_groups_user_normalized ON groups(user_id, normalized_name);

-- GIN trgm index for fast similarity searches
CREATE INDEX idx_groups_normalized_trgm ON groups USING gin (normalized_name gin_trgm_ops);

-- ===================== SUGGEST FUNCTIONS =====================

-- Suggest similar categories by trigram similarity
CREATE OR REPLACE FUNCTION suggest_categories(
  p_user_id BIGINT,
  p_query TEXT,
  p_limit INT DEFAULT 3,
  p_min_similarity REAL DEFAULT 0.3
) RETURNS TABLE(name TEXT, similarity REAL) AS $$
  SELECT c.name, similarity(c.normalized_name, normalize_string(p_query)) as sim
  FROM categories c
  WHERE c.user_id = p_user_id
    AND c.normalized_name % normalize_string(p_query)
    AND c.normalized_name <> normalize_string(p_query) -- exclude exact match
  ORDER BY sim DESC
  LIMIT p_limit;
$$ LANGUAGE SQL STABLE;

-- Suggest similar groups by trigram similarity
CREATE OR REPLACE FUNCTION suggest_groups(
  p_user_id BIGINT,
  p_query TEXT,
  p_limit INT DEFAULT 3,
  p_min_similarity REAL DEFAULT 0.3
) RETURNS TABLE(name TEXT, similarity REAL) AS $$
  SELECT g.name, similarity(g.normalized_name, normalize_string(p_query)) as sim
  FROM groups g
  WHERE g.user_id = p_user_id
    AND g.normalized_name % normalize_string(p_query)
    AND g.normalized_name <> normalize_string(p_query) -- exclude exact match
  ORDER BY sim DESC
  LIMIT p_limit;
$$ LANGUAGE SQL STABLE;

-- ===================== TAGS =====================

-- Suggest similar tags by trigram similarity (tags are TEXT[] on transactions)
CREATE OR REPLACE FUNCTION suggest_tags(
  p_user_id BIGINT,
  p_query TEXT,
  p_limit INT DEFAULT 3
) RETURNS TABLE("tag" TEXT, similarity REAL) AS $$
  SELECT DISTINCT ON (unnested.tag)
    unnested.tag,
    similarity(normalize_string(unnested.tag), normalize_string(p_query)) as sim
  FROM transactions t
  CROSS JOIN LATERAL unnest(t.tags) AS unnested(tag)
  WHERE t.user_id = p_user_id
    AND unnested.tag <> ''
    AND normalize_string(unnested.tag) % normalize_string(p_query)
    AND normalize_string(unnested.tag) <> normalize_string(p_query)
  ORDER BY unnested.tag, sim DESC
  LIMIT p_limit;
$$ LANGUAGE SQL STABLE;

-- Grant permissions
GRANT EXECUTE ON FUNCTION normalize_string TO service_role;
GRANT EXECUTE ON FUNCTION suggest_categories TO service_role;
GRANT EXECUTE ON FUNCTION suggest_groups TO service_role;
GRANT EXECUTE ON FUNCTION suggest_tags TO service_role;
