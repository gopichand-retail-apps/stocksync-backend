import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../auth/auth.types.js';
import { StockEventsService } from '../common/stock-events.service.js';
import { DatabaseService, type StockSyncTransaction } from '../database/database.service.js';
import { InventoryReadService } from './inventory-read.service.js';
import { InventoryReservationService } from './inventory-reservation.service.js';
import { InventoryStockService } from './inventory-stock.service.js';
import { InventoryService } from './inventory.service.js';
import { InventoryTransactionService } from './inventory-transaction.service.js';
import { InventoryTransferService } from './inventory-transfer.service.js';

describe('Inventory concurrency recovery', () => {
  const originalDataDirectory = process.env.STOCKSYNC_DATA_DIR;
  const originalNodeEnvironment = process.env.NODE_ENV;
  const manager: SessionUser = {
    id: 'user-manager',
    email: 'manager@stocksync.test',
    displayName: 'Morgan Patel',
    role: 'inventory_manager',
    homeLocationId: 'loc-central',
  };
  let database: DatabaseService;
  let transactions: InventoryTransactionService;
  let inventory: InventoryService;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.STOCKSYNC_DATA_DIR = 'memory://';
    database = new DatabaseService();
    await database.onModuleInit();
    transactions = new InventoryTransactionService(database);
    const events = new StockEventsService();
    inventory = new InventoryService(
      new InventoryReadService(database),
      new InventoryStockService(transactions, events),
      new InventoryTransferService(transactions, events),
      new InventoryReservationService(transactions, events),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await database.onModuleDestroy();
    if (originalDataDirectory === undefined) delete process.env.STOCKSYNC_DATA_DIR;
    else process.env.STOCKSYNC_DATA_DIR = originalDataDirectory;
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
  });

  function makeTransactionUpdateReturnNoRows(sqlFragment: string): void {
    const runTransaction = database.transaction.bind(database);
    vi.spyOn(database, 'transaction').mockImplementation(
      async <T>(operation: (transaction: StockSyncTransaction) => Promise<T>) =>
        runTransaction(async (transaction) => {
          const query = transaction.query.bind(transaction);
          vi.spyOn(transaction, 'query').mockImplementation(
            async <Row extends Record<string, unknown>>(sql: string, parameters: unknown[] = []) => {
              if (sql.includes(sqlFragment)) return query<Row>('SELECT 1 WHERE FALSE');
              return query<Row>(sql, parameters);
            },
          );
          return operation(transaction);
        }),
    );
  }

  it('rolls back a cycle-count variance when the version-guarded update loses a race', async () => {
    const initial = (await inventory.listInventory({ locationId: 'loc-central' })).find(
      (item) => item.skuId === 'sku-coffee',
    );
    if (!initial) throw new Error('Seeded test inventory is missing');
    makeTransactionUpdateReturnNoRows('UPDATE inventory SET on_hand = $3');

    await expect(
      inventory.reconcileCount(
        {
          locationId: initial.locationId,
          skuId: initial.skuId,
          expectedVersion: initial.version,
          countedQuantity: initial.onHand + 1,
        },
        manager,
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const current = (await inventory.listInventory({ locationId: initial.locationId })).find(
      (item) => item.skuId === initial.skuId,
    );
    const cycleCounts = await database.query<{ id: string }>(
      'SELECT id FROM cycle_counts WHERE location_id = $1 AND sku_id = $2',
      [initial.locationId, initial.skuId],
    );
    expect(current?.onHand).toBe(initial.onHand);
    expect(cycleCounts.rows).toHaveLength(0);
  });

  it('rejects a transfer when source stock changes after the initial balance read', async () => {
    const initial = (await inventory.listInventory({ locationId: 'loc-central' })).find(
      (item) => item.skuId === 'sku-coffee',
    );
    if (!initial) throw new Error('Seeded test inventory is missing');
    const quantity = initial.onHand - initial.reserved + 1;
    vi.spyOn(transactions, 'getBalance').mockResolvedValue({
      onHand: quantity + 1,
      reserved: 0,
      version: initial.version,
    });

    await expect(
      inventory.createTransfer(
        {
          fromLocationId: 'loc-central',
          toLocationId: 'loc-north',
          skuId: initial.skuId,
          quantity,
        },
        manager,
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const current = (await inventory.listInventory({ locationId: 'loc-central' })).find(
      (item) => item.skuId === initial.skuId,
    );
    const transfers = await database.query<{ id: string }>(
      'SELECT id FROM transfers WHERE sku_id = $1 AND from_location_id = $2',
      [initial.skuId, 'loc-central'],
    );
    expect(current?.onHand).toBe(initial.onHand);
    expect(transfers.rows).toHaveLength(0);
  });

  it('rolls back destination stock when transfer receipt loses its status race', async () => {
    const transfer = await inventory.createTransfer(
      { fromLocationId: 'loc-central', toLocationId: 'loc-north', skuId: 'sku-coffee', quantity: 1 },
      manager,
      randomUUID(),
    );
    const destinationBefore = (await inventory.listInventory({ locationId: 'loc-north' })).find(
      (item) => item.skuId === 'sku-coffee',
    );
    if (!destinationBefore) throw new Error('Seeded destination inventory is missing');
    makeTransactionUpdateReturnNoRows("UPDATE transfers SET status = 'received'");

    await expect(inventory.receiveTransfer(transfer.id, manager, randomUUID())).rejects.toBeInstanceOf(
      ConflictException,
    );

    const destinationAfter = (await inventory.listInventory({ locationId: 'loc-north' })).find(
      (item) => item.skuId === 'sku-coffee',
    );
    const storedTransfer = await database.query<{ status: string }>('SELECT status FROM transfers WHERE id = $1', [
      transfer.id,
    ]);
    expect(destinationAfter?.onHand).toBe(destinationBefore.onHand);
    expect(storedTransfer.rows[0]?.status).toBe('in_transit');
  });

  it('rolls back reservation release when the final status update loses its race', async () => {
    const reservation = await inventory.reserveStock(
      { locationId: 'loc-central', skuId: 'sku-coffee', quantity: 1 },
      manager,
      randomUUID(),
    );
    const before = (await inventory.listInventory({ locationId: 'loc-central' })).find(
      (item) => item.skuId === 'sku-coffee',
    );
    if (!before) throw new Error('Seeded inventory is missing');
    makeTransactionUpdateReturnNoRows("UPDATE reservations SET status = 'released'");

    await expect(inventory.releaseReservation(reservation.id, manager, randomUUID())).rejects.toBeInstanceOf(
      ConflictException,
    );

    const after = (await inventory.listInventory({ locationId: 'loc-central' })).find(
      (item) => item.skuId === 'sku-coffee',
    );
    const storedReservation = await database.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1',
      [reservation.id],
    );
    expect(after?.reserved).toBe(before.reserved);
    expect(storedReservation.rows[0]?.status).toBe('active');
  });
});
