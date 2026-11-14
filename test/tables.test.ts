import { Schema } from 'sqlex';

import { describeTables } from '../src/core/tables';

test('a table lists its columns, keys, what it references and what references it', () => {
  const schema = new Schema({
    name: 'test',
    tables: [
      {
        name: 'product',
        columns: [
          { name: 'id', type: 'integer', nullable: false, autoIncrement: true },
          { name: 'site_id', type: 'integer', nullable: false },
          { name: 'code', type: 'text', nullable: false },
          {
            name: 'price',
            type: 'numeric',
            nullable: true,
            precision: 19,
            scale: 4,
          },
          { name: 'currency', type: 'character', nullable: true, size: 3 },
          {
            name: 'is_gone',
            type: 'boolean',
            nullable: false,
            default: 'false',
          },
        ],
        constraints: [
          { columns: ['id'], primaryKey: true },
          { columns: ['site_id', 'code'], unique: true },
          {
            columns: ['site_id'],
            references: { table: 'site', columns: ['id'] },
            onDelete: 'CASCADE',
          },
        ],
      },
      {
        name: 'site',
        columns: [{ name: 'id', type: 'integer', nullable: false, autoIncrement: true }],
        constraints: [{ columns: ['id'], primaryKey: true }],
      },
    ],
  });
  const [product, site] = describeTables(schema);
  expect(product).toEqual({
    name: 'product',
    model: 'Product',
    columns: [
      {
        name: 'id',
        field: 'id',
        type: 'integer',
        nullable: false,
        default: 'identity',
      },
      {
        name: 'site_id',
        field: 'site',
        type: 'integer',
        nullable: false,
        default: undefined,
      },
      {
        name: 'code',
        field: 'code',
        type: 'text',
        nullable: false,
        default: undefined,
      },
      {
        name: 'price',
        field: 'price',
        type: 'numeric(19,4)',
        nullable: true,
        default: undefined,
      },
      {
        name: 'currency',
        field: 'currency',
        type: 'character(3)',
        nullable: true,
        default: undefined,
      },
      {
        name: 'is_gone',
        field: 'isGone',
        type: 'boolean',
        nullable: false,
        default: 'false',
      },
    ],
    primaryKey: ['id'],
    unique: [['site_id', 'code']],
    references: [{ columns: ['site_id'], table: 'site', to: ['id'], onDelete: 'CASCADE' }],
    referencedBy: [],
  });
  expect(site.referencedBy).toEqual([
    { columns: ['id'], table: 'product', to: ['site_id'], onDelete: 'CASCADE' },
  ]);
});
