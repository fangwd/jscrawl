-- A crawler may fetch through a proxy, pinned to a country (a Tor exit).
-- Nothing set proxy_type before, so a stray value is cleared, not kept.
ALTER TABLE crawler ADD COLUMN IF NOT EXISTS proxy_type text;
UPDATE crawler SET proxy_type = NULL WHERE proxy_type IS DISTINCT FROM 'tor';

ALTER TABLE crawler DROP CONSTRAINT IF EXISTS crawler_proxy_type_check;
ALTER TABLE crawler ADD CONSTRAINT crawler_proxy_type_check CHECK (proxy_type IN ('tor'));

ALTER TABLE crawler ADD COLUMN IF NOT EXISTS proxy_country char(2)
    CHECK (proxy_country ~ '^[A-Z]{2}$');

ALTER TABLE crawler DROP CONSTRAINT IF EXISTS crawler_proxy_country_needs_type;
ALTER TABLE crawler ADD CONSTRAINT crawler_proxy_country_needs_type
    CHECK (proxy_country IS NULL OR proxy_type IS NOT NULL);
