-- A crawl snapshot holds the domain's metrics as one JSON document rather than
-- the former `products` and `fields` columns; existing rows are converted in place. Safe to re-run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'crawl_snapshot' AND column_name = 'products'
  ) THEN
    ALTER TABLE crawl_snapshot ADD COLUMN IF NOT EXISTS metrics jsonb;
    UPDATE crawl_snapshot SET metrics = jsonb_build_object('products', products) || fields WHERE metrics IS NULL;
    ALTER TABLE crawl_snapshot ALTER COLUMN metrics SET NOT NULL;
    ALTER TABLE crawl_snapshot DROP COLUMN products, DROP COLUMN fields;
  END IF;
END $$;
