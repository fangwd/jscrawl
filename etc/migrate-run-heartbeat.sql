-- A run's process beats (heartbeat_at, on host) while it is alive, and a url a
-- crawl claims names its run, so a dead run's urls are released as soon as it
-- is found dead. Runs and claims from before cannot be told alive: the runs
-- are over and their busy urls go back to idle. Runs once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'crawler_run' AND column_name = 'heartbeat_at'
  ) THEN
    ALTER TABLE crawler_run ADD COLUMN host text, ADD COLUMN heartbeat_at timestamptz;
    UPDATE crawler_run SET status = 'interrupted', stopped_at = now() WHERE status = 'running';
    CREATE UNIQUE INDEX idx_crawler_run_one_crawl ON crawler_run (site_id) WHERE kind = 'crawl' AND status = 'running';
    ALTER TABLE url ADD COLUMN claimed_run_id bigint;
    ALTER TABLE url ADD CONSTRAINT url_claimed_run_fk FOREIGN KEY (claimed_run_id) REFERENCES crawler_run(id) ON DELETE SET NULL;
    UPDATE url SET status = 0 WHERE status = 1;
    CREATE INDEX idx_url_claimed_run ON url (claimed_run_id) WHERE status = 1;
  END IF;
END $$;
