import { databaseConformance } from '../src/core/testing/conformance';
import { TestDatabase } from './support/domain';

const connection = {
  dialect: 'postgres' as const,
  connection: {
    host: '127.0.0.1',
    port: 5434,
    user: 'admin',
    password: 'secret',
    database: 'jscrawl_test',
  },
};

const checks = databaseConformance({
  database: () => new TestDatabase(connection),
  tables: ['page'],
  page(db, url) {
    (db as TestDatabase).addPage(url, 'A page', 'its body');
  },
});

describe('the test domain database conforms to the core write protocol', () => {
  for (const check of checks) test(check.name, check.run);
});
