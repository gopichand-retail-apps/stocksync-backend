import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { initialSchema } from './migrations/001_initial_schema.js';
import { seedDemoData } from './seed.js';

const INITIAL_MIGRATION = '001_initial_schema';
type TransactionClient = Parameters<Parameters<PGlite['transaction']>[0]>[0];

export type StockSyncTransaction = TransactionClient;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly client: PGlite;

  constructor() {
    const configuredDataDirectory = process.env.STOCKSYNC_DATA_DIR;
    if (
      configuredDataDirectory === 'memory://' ||
      (process.env.NODE_ENV === 'test' && configuredDataDirectory === undefined)
    ) {
      this.client = new PGlite();
      return;
    }

    const dataDirectory = configuredDataDirectory ?? join(process.cwd(), 'data', 'stocksync');
    mkdirSync(dataDirectory, { recursive: true });
    this.client = new PGlite(dataDirectory);
  }

  async onModuleInit(): Promise<void> {
    await this.client.waitReady;
    await this.client.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const result = await this.client.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [INITIAL_MIGRATION],
    );
    if (result.rows.length === 0) {
      await this.client.transaction(async (tx) => {
        await tx.exec(initialSchema);
        await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [INITIAL_MIGRATION]);
      });
    }

    await seedDemoData(this.client);
  }

  query<T extends Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<{ rows: T[] }> {
    return this.client.query<T>(sql, parameters);
  }

  transaction<T>(operation: (transaction: StockSyncTransaction) => Promise<T>): Promise<T> {
    return this.client.transaction(operation);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}
