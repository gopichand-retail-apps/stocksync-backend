import { randomUUID } from 'node:crypto';
import { ConflictException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { StockEventsService } from '../common/stock-events.service.js';
import type { SessionUser } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import { InventoryReadService } from './inventory-read.service.js';
import { InventoryReservationService } from './inventory-reservation.service.js';
import { InventoryStockService } from './inventory-stock.service.js';
import { InventoryService } from './inventory.service.js';
import { InventoryTransactionService } from './inventory-transaction.service.js';
import { InventoryTransferService } from './inventory-transfer.service.js';

describe('Inventory workflow edge cases', () => {
  const originalDataDirectory = process.env.STOCKSYNC_DATA_DIR;
  const originalNodeEnvironment = process.env.NODE_ENV;
  const manager: SessionUser = {
    id: 'user-manager',
    email: 'manager@stocksync.test',
    displayName: 'Morgan Patel',
    role: 'inventory_manager',
    homeLocationId: 'loc-central',
  };
  const associate: SessionUser = {
    id: 'user-associate',
    email: 'associate@stocksync.test',
    displayName: 'Jamie Lee',
    role: 'associate',
    homeLocationId: 'loc-central',
  };
  let database: DatabaseService;
  let inventory: InventoryService;
  let transactions: InventoryTransactionService;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.STOCKSYNC_DATA_DIR;
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

  afterAll(async () => {
    await database.onModuleDestroy();
    if (originalDataDirectory === undefined) delete process.env.STOCKSYNC_DATA_DIR;
    else process.env.STOCKSYNC_DATA_DIR = originalDataDirectory;
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
  });

  it('supports unfiltered reads, default ledger limits, and the lower limit bound', async () => {
    const items = await inventory.listInventory({});
    const overview = await inventory.getOverview();
    const defaultLedger = await inventory.listLedger();
    const minimumLedger = await inventory.listLedger(undefined, 0);

    expect(items).toHaveLength(18);
    expect(overview.metrics.skuCount).toBe(6);
    expect(defaultLedger.length).toBeGreaterThan(1);
    expect(minimumLedger).toHaveLength(1);
    await expect(inventory.listTransfers()).resolves.toEqual([]);
    await expect(inventory.listReservations()).resolves.toEqual([]);
  });

  it('uses zero-valued overview defaults when aggregate queries return no rows', async () => {
    const emptyDatabase = {
      query: async () => ({ rows: [] }),
    } as unknown as DatabaseService;
    const overview = await new InventoryReadService(emptyDatabase).getOverview();

    expect(overview.metrics).toEqual({
      skuCount: 0,
      unitsOnHand: 0,
      reservedUnits: 0,
      lowStockCount: 0,
      activeTransfers: 0,
    });
    expect(overview.lowStock).toEqual([]);
    expect(overview.activity).toEqual([]);
  });

  it('allows associates to receive stock at their home location', async () => {
    const before = (await inventory.listInventory({ locationId: associate.homeLocationId })).find(
      (item) => item.skuId === 'sku-coffee',
    );
    if (!before) throw new Error('Seeded test inventory is missing');

    const receipt = await inventory.receiveStock(
      { locationId: associate.homeLocationId, skuId: before.skuId, quantity: 1 },
      associate,
      'associate-home-receipt-edge-01',
    );

    expect(receipt.onHand).toBe(before.onHand + 1);
  });

  it('replays reservations and releases once, and rejects missing reservations', async () => {
    const input = { locationId: 'loc-central', skuId: 'sku-bags', quantity: 1, note: 'order hold' };
    const created = await inventory.reserveStock(input, manager, 'reservation-replay-edge-01');
    const replay = await inventory.reserveStock(input, manager, 'reservation-replay-edge-01');
    const released = await inventory.releaseReservation(created.id, manager, 'reservation-release-edge-01');
    const releaseReplay = await inventory.releaseReservation(created.id, manager, 'reservation-release-edge-01');

    expect(replay).toEqual(created);
    expect(releaseReplay).toEqual(released);
    expect(released.status).toBe('released');
    await expect(
      inventory.releaseReservation('00000000-0000-4000-8000-000000000001', manager, 'missing-reservation-edge-01'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('replays a cycle count without applying its variance twice', async () => {
    const current = (await inventory.listInventory({ locationId: 'loc-central' })).find(
      (item) => item.skuId === 'sku-oat-milk',
    );
    if (!current) throw new Error('Seeded test inventory is missing');
    const input = {
      locationId: current.locationId,
      skuId: current.skuId,
      expectedVersion: current.version,
      countedQuantity: current.onHand + 1,
    };

    const first = await inventory.reconcileCount(input, manager, 'cycle-count-replay-edge-0001');
    const replay = await inventory.reconcileCount(input, manager, 'cycle-count-replay-edge-0001');
    const updated = (await inventory.listInventory({ locationId: current.locationId })).find(
      (item) => item.skuId === current.skuId,
    );

    expect(replay).toEqual(first);
    expect(first.variance).toBe(1);
    expect(updated?.onHand).toBe(current.onHand + 1);
  });

  it('replays an adjustment without applying its stock delta twice', async () => {
    const input = {
      locationId: 'loc-central',
      skuId: 'sku-tea',
      delta: 1,
      note: 'audit correction',
    };
    const before = (await inventory.listInventory({ locationId: input.locationId })).find(
      (item) => item.skuId === input.skuId,
    );
    if (!before) throw new Error('Seeded test inventory is missing');

    const first = await inventory.adjustStock(input, manager, 'adjustment-replay-edge-0001');
    const replay = await inventory.adjustStock(input, manager, 'adjustment-replay-edge-0001');
    const after = (await inventory.listInventory({ locationId: input.locationId })).find(
      (item) => item.skuId === input.skuId,
    );

    expect(replay).toEqual(first);
    expect(after?.onHand).toBe(before.onHand + 1);
  });

  it('replays transfer creation and receipt without moving stock twice', async () => {
    const input = {
      fromLocationId: 'loc-central',
      toLocationId: 'loc-north',
      skuId: 'sku-soap',
      quantity: 1,
    };
    const sourceBefore = (await inventory.listInventory({ locationId: input.fromLocationId })).find(
      (item) => item.skuId === input.skuId,
    );
    const destinationBefore = (await inventory.listInventory({ locationId: input.toLocationId })).find(
      (item) => item.skuId === input.skuId,
    );
    if (!sourceBefore || !destinationBefore) throw new Error('Seeded transfer inventory is missing');

    const created = await inventory.createTransfer(input, manager, 'transfer-replay-edge-create-01');
    const creationReplay = await inventory.createTransfer(input, manager, 'transfer-replay-edge-create-01');
    const received = await inventory.receiveTransfer(created.id, manager, 'transfer-replay-edge-receive-01');
    const receiptReplay = await inventory.receiveTransfer(created.id, manager, 'transfer-replay-edge-receive-01');
    const sourceAfter = (await inventory.listInventory({ locationId: input.fromLocationId })).find(
      (item) => item.skuId === input.skuId,
    );
    const destinationAfter = (await inventory.listInventory({ locationId: input.toLocationId })).find(
      (item) => item.skuId === input.skuId,
    );

    expect(creationReplay).toEqual(created);
    expect(receiptReplay).toEqual(received);
    expect(sourceAfter?.onHand).toBe(sourceBefore.onHand - input.quantity);
    expect(destinationAfter?.onHand).toBe(destinationBefore.onHand + input.quantity);
    await expect(
      inventory.receiveTransfer('00000000-0000-4000-8000-000000000002', manager, 'transfer-missing-edge-0001'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stores nulls for omitted optional ledger reference fields', async () => {
    const id = randomUUID();
    await database.transaction((transaction) =>
      transactions.appendLedger(transaction, {
        id,
        locationId: 'loc-central',
        skuId: 'sku-tea',
        movementType: 'receipt',
        delta: 1,
        actorId: manager.id,
      }),
    );
    const entry = (await inventory.listLedger('loc-central', 100)).find((item) => item.id === id);

    expect(entry).toMatchObject({ referenceId: null, note: null });
  });

  it('surfaces invalid stored idempotency results without applying another stock change', async () => {
    const input = { locationId: 'loc-central', skuId: 'sku-tea', quantity: 1 };
    const key = 'corrupt-result-edge-0001';
    const receipt = await inventory.receiveStock(input, manager, key);
    await database.query(
      `UPDATE idempotency_records SET response_json = $1::jsonb
       WHERE scope = $2 AND idempotency_key = $3`,
      [JSON.stringify({ invalid: true }), `${manager.id}:receipt`, key],
    );

    await expect(inventory.receiveStock(input, manager, key)).rejects.toBeInstanceOf(InternalServerErrorException);
    const current = (await inventory.listInventory({ locationId: input.locationId })).find(
      (item) => item.skuId === input.skuId,
    );
    expect(current?.onHand).toBe(receipt.onHand);
  });

  it('rejects non-serializable idempotency payloads before starting a transaction', async () => {
    await expect(
      transactions.runIdempotent({
        scope: 'test:non-serializable',
        key: 'non-serializable-edge-0001',
        payload: undefined,
        responseSchema: z.object({}),
        operation: async () => ({}),
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('leaves a transfer in transit when destination inventory is missing', async () => {
    const transfer = await inventory.createTransfer(
      {
        fromLocationId: 'loc-central',
        toLocationId: 'loc-north',
        skuId: 'sku-citrus',
        quantity: 1,
      },
      manager,
      'missing-destination-create-edge-01',
    );
    await database.query('DELETE FROM inventory WHERE location_id = $1 AND sku_id = $2', [
      transfer.toLocationId,
      transfer.skuId,
    ]);

    await expect(
      inventory.receiveTransfer(transfer.id, manager, 'missing-destination-receive-edge-01'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const remaining = await inventory.listTransfers(transfer.toLocationId);
    expect(remaining.find((item) => item.id === transfer.id)?.status).toBe('in_transit');
  });

  it('rejects counts for inventory that does not exist', async () => {
    await expect(
      inventory.reconcileCount(
        {
          locationId: 'loc-central',
          skuId: 'sku-not-seeded',
          expectedVersion: 1,
          countedQuantity: 1,
        },
        manager,
        'missing-count-item-edge-0001',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rolls back reservation release when the inventory balance is missing', async () => {
    const reservation = await inventory.reserveStock(
      { locationId: 'loc-harbor', skuId: 'sku-soap', quantity: 1 },
      manager,
      'missing-balance-reservation-edge-01',
    );
    await database.query('DELETE FROM inventory WHERE location_id = $1 AND sku_id = $2', [
      reservation.locationId,
      reservation.skuId,
    ]);

    await expect(
      inventory.releaseReservation(reservation.id, manager, 'missing-balance-release-edge-01'),
    ).rejects.toBeInstanceOf(ConflictException);
    const status = await database.query<{ status: string }>('SELECT status FROM reservations WHERE id = $1', [
      reservation.id,
    ]);
    expect(status.rows[0]?.status).toBe('active');
  });
});
