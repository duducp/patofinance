-- Fix normalize_string function: TRANSLATE counts were wrong (extra chars)
-- Bug: 'aaaaaaaaeeeeeeeeiiiioooooouuuuucn' (31 chars) vs 25 from chars
-- Fix: 'aaaaaaeeeeiiiiooooouuuucn' (25 chars, matching the 25 from chars)
CREATE OR REPLACE FUNCTION normalize_string(s TEXT) RETURNS TEXT AS $$
BEGIN
  s := LOWER(s);
  s := TRANSLATE(s,
    'áàâãäåéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
    'aaaaaaeeeeiiiiooooouuuucnAAAAAAEEEEIIIIOOOOOUUUUCN');
  s := REGEXP_REPLACE(s, '[^a-z0-9]', '', 'g');
  RETURN s;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- Re-populate normalized_name for all categories with corrected function
UPDATE categories SET normalized_name = normalize_string(name) WHERE normalized_name IS NOT NULL;

-- Re-populate normalized_name for all groups with corrected function
UPDATE groups SET normalized_name = normalize_string(name) WHERE normalized_name IS NOT NULL;
