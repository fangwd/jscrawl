import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * The core's migrations are additive: a domain's
 * foreign keys point at site.id and url.id, so those tables' columns are never
 * dropped or renamed by a core migration.
 */
test('core migrations never drop or rename a column of site or url', () => {
  const etc = join(__dirname, '..', 'etc');
  const offending: string[] = [];
  for (const name of readdirSync(etc).filter((f) => /^migrate-.*\.sql$/.test(f))) {
    const sql = readFileSync(join(etc, name), 'utf8');
    for (const statement of sql.split(';')) {
      if (/alter\s+table\s+(site|url)\b[\s\S]*\b(drop\s+column|rename)\b/i.test(statement)) {
        offending.push(`${name}: ${statement.trim().split('\n')[0]}`);
      }
    }
  }
  expect(offending).toEqual([]);
});
