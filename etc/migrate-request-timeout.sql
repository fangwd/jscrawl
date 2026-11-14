-- How long a crawl's request may go without an answer before it is retried,
-- per crawler; 30 seconds, as before, until its module says otherwise.
ALTER TABLE crawler ADD COLUMN IF NOT EXISTS request_timeout integer NOT NULL DEFAULT 30
    CHECK (request_timeout > 0);
