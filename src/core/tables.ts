// The database's tables as sqlex reads them: each table's columns, keys, the
// tables it references and the ones referencing it - for the dashboard's schema
// page and its SQL console.

import { Schema } from 'sqlex';

export interface ColumnInfo {
  name: string;
  /** The column's name in the records API and sqlex ('priceDelta'). */
  field?: string;
  /** With its size or precision: 'character(3)', 'numeric(19,4)'. */
  type: string;
  nullable: boolean;
  /** The SQL default; 'identity' for a generated key. */
  default?: string;
}

export interface Reference {
  columns: string[];
  table: string;
  /** The columns on `table`: referenced by these, or referencing them. */
  to: string[];
  onDelete?: string;
}

export interface TableInfo {
  name: string;
  /** sqlex's model name, the records API's ('ProductAttributeValue'). */
  model: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  unique: string[][];
  references: Reference[];
  referencedBy: Reference[];
}

const typeOf = ({
  type,
  size,
  precision,
  scale,
}: {
  type: string;
  size?: number;
  precision?: number;
  scale?: number;
}) =>
  size
    ? `${type}(${size})`
    : precision != null
      ? `${type}(${precision}${scale ? `,${scale}` : ''})`
      : type;

/** Every table, by name. */
export function describeTables(schema: Schema): TableInfo[] {
  const tables = schema.models.map((model): TableInfo => {
    const { columns, constraints } = model.table;
    // a field over a column (a relation's key too) carries it; a related list or a formula does not
    const fieldOf = new Map(
      model.fields.flatMap((f) =>
        'column' in f ? [[(f as { column: { name: string } }).column.name, f.name] as const] : [],
      ),
    );
    return {
      name: model.table.name,
      model: model.name,
      columns: columns.map((column) => ({
        name: column.name,
        field: fieldOf.get(column.name),
        type: typeOf(column),
        nullable: column.nullable ?? true,
        default: column.autoIncrement
          ? 'identity'
          : column.default != null
            ? String(column.default)
            : undefined,
      })),
      primaryKey: constraints.find((c) => c.primaryKey)?.columns ?? [],
      unique: constraints.filter((c) => c.unique).map((c) => c.columns),
      references: constraints.flatMap((c) =>
        c.references
          ? [
              {
                columns: c.columns,
                table: c.references.table,
                to: c.references.columns,
                onDelete: c.onDelete,
              },
            ]
          : [],
      ),
      referencedBy: [],
    };
  });
  const byName = new Map(tables.map((table) => [table.name, table]));
  for (const table of tables) {
    for (const ref of table.references) {
      byName.get(ref.table)?.referencedBy.push({
        columns: ref.to,
        table: table.name,
        to: ref.columns,
        onDelete: ref.onDelete,
      });
    }
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}
