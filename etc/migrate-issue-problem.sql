-- An issue's problem code decides which issues are one problem. Existing issues
-- take their detail with URLs masked. Copies grouped under the old rule (page
-- type and kind alone) whose code differs from their original's are detached:
-- unsettled ones go back to open for their own review. Runs once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'issue' AND column_name = 'problem'
  ) THEN
    ALTER TABLE issue ADD COLUMN problem text;
    UPDATE issue SET problem = regexp_replace(detail, 'https?://[^[:space:]]+', '<url>', 'g');
    UPDATE issue c SET status = 'open', resolved_at = NULL, same_as = NULL, verdict = NULL,
           resolution = 'The previous grouped verdict did not match this failure; review this issue separately.'
      FROM issue i
     WHERE c.same_as = i.id AND c.problem <> i.problem AND c.status IN ('open', 'triaged');
    UPDATE issue c SET same_as = NULL
      FROM issue i
     WHERE c.same_as = i.id AND c.problem <> i.problem;
    ALTER TABLE issue ALTER COLUMN problem SET NOT NULL;
    CREATE INDEX idx_issue_problem ON issue (kind, problem);
  END IF;
END $$;
