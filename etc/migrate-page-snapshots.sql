-- Add a per-crawler response storage policy without rewriting existing files.
ALTER TABLE crawler ADD COLUMN IF NOT EXISTS page_snapshots text NOT NULL
    DEFAULT 'gzip' CHECK (page_snapshots IN ('gzip', 'raw', 'off'));
