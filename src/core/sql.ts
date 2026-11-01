// Read-only SQL over the crawler database, shared by the agent's jscrawl_sql tool
// and the dashboard's SQL console: the database, not a parser, enforces it.

import { Database } from 'sqlex';

export interface QueryResult {
  columns: string[];
  rows: { [column: string]: unknown }[];
  /** More than `maxRows` rows matched; `rows` holds the first `maxRows`. */
  truncated: boolean;
}

/** Runs one SELECT (or WITH) query in a read-only transaction with a 30s timeout. */
export async function readOnlyQuery(
  db: Database,
  query: string,
  { maxRows, signal }: { maxRows: number; signal?: AbortSignal }
): Promise<QueryResult> {
  const result = await db.transaction(async (connection) => {
    await connection.query('set transaction read only');
    await connection.query("set local statement_timeout = '30s'");
    // Taking a snapshot prevents SET/set_config from switching this transaction to read-write.
    await connection.query('select 1');
    signal?.throwIfAborted();
    // Extended protocol rejects multiple statements. The subquery also excludes
    // transaction control and SET, while PostgreSQL rejects ordinary data writes.
    // sqlex exposes its pg client but its query() uses the simple protocol.
    return connection.connection.query({
      text: `select * from (${query.trim().replace(/;$/, '')}\n) as read_only_query limit ${maxRows + 1}`,
      queryMode: 'extended',
    });
  });
  signal?.throwIfAborted();
  const rows = result.rows as QueryResult['rows'];
  return {
    columns: (result.fields as { name: string }[]).map((field) => field.name),
    rows: rows.slice(0, maxRows),
    truncated: rows.length > maxRows,
  };
}

/** Every public table with its columns, in declaration order. */
export async function tableColumns(db: Database) {
  const columns = await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }[]>(
    `select table_name, column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`
  );
  const byTable = new Map<string, { name: string; type: string; nullable: boolean }[]>();
  for (const column of columns) {
    const list = byTable.get(column.table_name) ?? [];
    list.push({ name: column.column_name, type: column.data_type, nullable: column.is_nullable === 'YES' });
    byTable.set(column.table_name, list);
  }
  return byTable;
}
