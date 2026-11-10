import { createHash } from 'node:crypto';
import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService, type StockSyncTransaction } from '../database/database.service.js';
import type { SessionUser } from '../auth/auth.types.js';

interface BalanceRow extends Record<string, unknown> {
  onHand: number;
  reserved: number;
  version: number;
}

interface IdempotencyRow extends Record<string, unknown> {
  request_hash: string;
  response_json: unknown;
}

interface IdempotentOperation<T extends object> {
  scope: string;
  key: string;
  payload: unknown;
  responseSchema: z.ZodType<T>;
  operation: (transaction: StockSyncTransaction) => Promise<T>;
}

interface LedgerEntryInput {
  id: string;
  locationId: string;
  skuId: string;
  movementType: string;
  delta: number;
  referenceId?: string;
  note?: string;
  actorId: string;
}

@Injectable()
export class InventoryTransactionService {
  constructor(private readonly database: DatabaseService) {}

  async getBalance(
    transaction: StockSyncTransaction,
    locationId: string,
    skuId: string,
  ): Promise<BalanceRow | undefined> {
    const result = await transaction.query<BalanceRow>(
      `SELECT on_hand AS "onHand", reserved, version
       FROM inventory WHERE location_id = $1 AND sku_id = $2`,
      [locationId, skuId],
    );
    return result.rows[0];
  }

  async appendLedger(transaction: StockSyncTransaction, entry: LedgerEntryInput): Promise<void> {
    await transaction.query(
      `INSERT INTO stock_ledger
        (id, location_id, sku_id, movement_type, quantity_delta, reference_id, note, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.id,
        entry.locationId,
        entry.skuId,
        entry.movementType,
        entry.delta,
        entry.referenceId ?? null,
        entry.note ?? null,
        entry.actorId,
      ],
    );
  }

  async runIdempotent<T extends object>(input: IdempotentOperation<T>): Promise<{ value: T; replayed: boolean }> {
    const serialized = JSON.stringify(input.payload);
    if (!serialized) throw new InternalServerErrorException('Unable to prepare idempotency record');
    const requestHash = createHash('sha256').update(serialized).digest('hex');

    return this.database.transaction(async (transaction) => {
      const existing = await transaction.query<IdempotencyRow>(
        `SELECT request_hash, response_json FROM idempotency_records
         WHERE scope = $1 AND idempotency_key = $2`,
        [input.scope, input.key],
      );
      const record = existing.rows[0];
      if (record) return this.replayResult(record, requestHash, input.responseSchema);

      const value = await input.operation(transaction);
      await transaction.query(
        `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response_json)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [input.scope, input.key, requestHash, JSON.stringify(value)],
      );
      return { value, replayed: false };
    });
  }

  assertLocationAccess(user: SessionUser, locationId: string): void {
    if (user.role === 'associate' && user.homeLocationId !== locationId) {
      throw new NotFoundException('Location was not found');
    }
  }

  private replayResult<T extends object>(
    record: IdempotencyRow,
    requestHash: string,
    responseSchema: z.ZodType<T>,
  ): { value: T; replayed: true } {
    if (record.request_hash !== requestHash) {
      throw new ConflictException('Idempotency key was already used for a different request');
    }
    const parsed = responseSchema.safeParse(record.response_json);
    if (!parsed.success) throw new InternalServerErrorException('Stored operation result is invalid');
    return { value: parsed.data, replayed: true };
  }
}
