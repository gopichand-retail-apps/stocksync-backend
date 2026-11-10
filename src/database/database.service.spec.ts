import { verify } from '@node-rs/argon2';
import { DatabaseService } from './database.service.js';

describe('DatabaseService', () => {
  const originalDataDirectory = process.env.STOCKSYNC_DATA_DIR;
  const originalNodeEnvironment = process.env.NODE_ENV;
  let database: DatabaseService;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.STOCKSYNC_DATA_DIR;
    database = new DatabaseService();
    await database.onModuleInit();
  });

  afterAll(async () => {
    await database.onModuleDestroy();
    if (originalDataDirectory === undefined) {
      delete process.env.STOCKSYNC_DATA_DIR;
    } else {
      process.env.STOCKSYNC_DATA_DIR = originalDataDirectory;
    }
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
  });

  it('applies the schema and seeds synthetic locations, SKUs, users, and ledger rows', async () => {
    const result = await database.query<{
      locations: number;
      skus: number;
      users: number;
      ledger_rows: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::integer FROM locations) AS locations,
        (SELECT COUNT(*)::integer FROM skus) AS skus,
        (SELECT COUNT(*)::integer FROM users) AS users,
        (SELECT COUNT(*)::integer FROM stock_ledger) AS ledger_rows
    `);

    expect(result.rows[0]).toEqual({ locations: 3, skus: 6, users: 3, ledger_rows: 18 });
  });

  it('keeps demo passwords out of the stored account records', async () => {
    const result = await database.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', [
      'manager@stocksync.test',
    ]);

    expect(result.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(result.rows[0]?.password_hash).not.toContain('stock-demo-only');
  });

  it('keeps migrations and synthetic seed data stable when initialization is repeated', async () => {
    await database.onModuleInit();
    const result = await database.query<{ migration_count: number; user_count: number }>(`
      SELECT
        (SELECT COUNT(*)::integer FROM schema_migrations) AS migration_count,
        (SELECT COUNT(*)::integer FROM users) AS user_count
    `);

    expect(result.rows[0]).toEqual({ migration_count: 1, user_count: 3 });
    const scalar = await database.query<{ value: number }>('SELECT 1::integer AS value');
    expect(scalar.rows).toEqual([{ value: 1 }]);
  });

  it('uses explicit memory mode and hashes the configured synthetic password', async () => {
    const originalDirectory = process.env.STOCKSYNC_DATA_DIR;
    const originalDemoPassword = process.env.STOCKSYNC_DEMO_PASSWORD;
    const password = 'stocksync-test-password';
    process.env.STOCKSYNC_DATA_DIR = 'memory://';
    process.env.STOCKSYNC_DEMO_PASSWORD = password;
    const memoryDatabase = new DatabaseService();
    let initialized = false;

    try {
      await memoryDatabase.onModuleInit();
      initialized = true;
      const result = await memoryDatabase.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE email = $1',
        ['manager@stocksync.test'],
      );
      const passwordHash = result.rows[0]?.password_hash;
      if (!passwordHash) throw new Error('Configured synthetic user was not seeded');

      await expect(verify(passwordHash, password)).resolves.toBe(true);
    } finally {
      if (initialized) await memoryDatabase.onModuleDestroy();
      if (originalDirectory === undefined) delete process.env.STOCKSYNC_DATA_DIR;
      else process.env.STOCKSYNC_DATA_DIR = originalDirectory;
      if (originalDemoPassword === undefined) delete process.env.STOCKSYNC_DEMO_PASSWORD;
      else process.env.STOCKSYNC_DEMO_PASSWORD = originalDemoPassword;
    }
  });
});
