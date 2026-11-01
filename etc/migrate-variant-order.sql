-- A product's variants keep the site's order in sort_order: ids no longer
-- follow it, since sqlex 5 writes a batch in key order. Existing variants start
-- at 0, in id order, until their pages are scraped again.
ALTER TABLE product_variant ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
