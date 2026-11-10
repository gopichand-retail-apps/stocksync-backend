import { ConflictException, NotFoundException } from '@nestjs/common';
import { StockEventsService } from '../common/stock-events.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { SessionUser } from '../auth/auth.types.js';
import { InventoryReadService } from './inventory-read.service.js';
import { InventoryReservationService } from './inventory-reservation.service.js';
import { InventoryStockService } from './inventory-stock.service.js';
import { InventoryService } from './inventory.service.js';
import { InventoryTransactionService } from './inventory-transaction.service.js';
import { InventoryTransferService } from './inventory-transfer.service.js';

describe('InventoryService', () => {
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

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.STOCKSYNC_DATA_DIR;
    database = new DatabaseService();
    await database.onModuleInit();
    const transactions = new InventoryTransactionService(database);
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
    if (originalDataDirectory === undefined) {
      delete process.env.STOCKSYNC_DATA_DIR;
    } else {
      process.env.STOCKSYNC_DATA_DIR = originalDataDirectory;
    }
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
  });

  it('applies a receipt once when the same idempotency key is replayed', async () => {
    const input = { locationId: 'loc-central', skuId: 'sku-coffee', quantity: 3 };
    const first = await inventory.receiveStock(input, manager, 'receipt-test-0001');
    const replay = await inventory.receiveStock(input, manager, 'receipt-test-0001');
    const item = (await inventory.listInventory({ locationId: input.locationId })).find(
      (row) => row.skuId === input.skuId,
    );

    expect(replay).toEqual(first);
    expect(item?.onHand).toBe(45);
  });

  it('rejects reuse of an idempotency key with a different payload', async () => {
    const input = { locationId: 'loc-central', skuId: 'sku-bags', quantity: 1 };
    await inventory.receiveStock(input, manager, 'receipt-payload-conflict-01');

    await expect(
      inventory.receiveStock({ ...input, quantity: 2 }, manager, 'receipt-payload-conflict-01'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a receipt for an unknown SKU without changing inventory', async () => {
    await expect(
      inventory.receiveStock(
        { locationId: 'loc-central', skuId: 'sku-missing', quantity: 1 },
        manager,
        'receipt-missing-sku-0001',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('limits associates to their home location before reading or mutating stock', async () => {
    await expect(inventory.listLocations(associate.homeLocationId)).resolves.toHaveLength(1);
    await expect(
      inventory.receiveStock(
        { locationId: 'loc-north', skuId: 'sku-coffee', quantity: 1 },
        associate,
        'associate-cross-location-0001',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('serves filtered inventory, category, overview, ledger, transfer, and reservation read models', async () => {
    const locations = await inventory.listLocations();
    const filtered = await inventory.listInventory({
      locationId: 'loc-central',
      search: 'coffee',
      category: 'Grocery',
    });
    const categories = await inventory.listCategories();
    const summary = await inventory.getOverview('loc-central');
    const ledger = await inventory.listLedger('loc-central', 2);
    const transfers = await inventory.listTransfers('loc-central');
    const reservations = await inventory.listReservations('loc-central');

    expect(locations).toHaveLength(3);
    expect(filtered.map((item) => item.skuId)).toEqual(['sku-coffee']);
    expect(categories).toContain('Grocery');
    expect(summary.metrics.skuCount).toBe(6);
    expect(summary.activity.length).toBeGreaterThan(0);
    expect(ledger).toHaveLength(2);
    expect(transfers).toEqual(expect.any(Array));
    expect(reservations).toEqual(expect.any(Array));
  });

  it('moves stock through an in-transit transfer and records both ledger legs', async () => {
    const transfer = await inventory.createTransfer(
      {
        fromLocationId: 'loc-central',
        toLocationId: 'loc-north',
        skuId: 'sku-coffee',
        quantity: 2,
      },
      manager,
      'transfer-create-test-01',
    );
    const received = await inventory.receiveTransfer(transfer.id, manager, 'transfer-receive-test-01');

    expect(transfer.status).toBe('in_transit');
    expect(received.status).toBe('received');
    expect(received.onHand).toBe(19);
    expect((await inventory.listTransfers())[0]?.status).toBe('received');
  });

  it('receives a transfer only once when separate requests race', async () => {
    const transfer = await inventory.createTransfer(
      {
        fromLocationId: 'loc-central',
        toLocationId: 'loc-harbor',
        skuId: 'sku-soap',
        quantity: 1,
      },
      manager,
      'transfer-race-create-0001',
    );
    const before = (await inventory.listInventory({ locationId: 'loc-harbor' })).find(
      (row) => row.skuId === 'sku-soap',
    );
    if (!before) throw new Error('Seeded test inventory is missing');

    const results = await Promise.allSettled([
      inventory.receiveTransfer(transfer.id, manager, 'transfer-race-receive-0001'),
      inventory.receiveTransfer(transfer.id, manager, 'transfer-race-receive-0002'),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.find((result) => result.status === 'rejected');
    const after = (await inventory.listInventory({ locationId: 'loc-harbor' })).find((row) => row.skuId === 'sku-soap');
    const receiptEntries = (await inventory.listLedger('loc-harbor', 100)).filter(
      (entry) => entry.referenceId === transfer.id && entry.movementType === 'transfer_in',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(after?.onHand).toBe(before.onHand + transfer.quantity);
    expect(receiptEntries).toHaveLength(1);
  });

  it('does not replay another user’s transfer receipt result', async () => {
    const transfer = await inventory.createTransfer(
      {
        fromLocationId: 'loc-central',
        toLocationId: 'loc-north',
        skuId: 'sku-coffee',
        quantity: 1,
      },
      manager,
      'transfer-scope-create-0001',
    );
    const key = 'transfer-shared-key-test-01';
    await inventory.receiveTransfer(transfer.id, manager, key);

    await expect(inventory.receiveTransfer(transfer.id, associate, key)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a cycle count opened against a stale stock version', async () => {
    const original = (await inventory.listInventory({ locationId: 'loc-harbor' })).find(
      (row) => row.skuId === 'sku-tea',
    );
    if (!original) throw new Error('Seeded test inventory is missing');

    await inventory.receiveStock(
      { locationId: original.locationId, skuId: original.skuId, quantity: 1 },
      manager,
      'count-concurrency-receipt-01',
    );
    await expect(
      inventory.reconcileCount(
        {
          locationId: original.locationId,
          skuId: original.skuId,
          expectedVersion: original.version,
          countedQuantity: original.onHand,
        },
        manager,
        'count-concurrency-check-01',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('records an unchanged physical count without creating a stock movement', async () => {
    const current = (await inventory.listInventory({ locationId: 'loc-central' })).find(
      (row) => row.skuId === 'sku-bags',
    );
    if (!current) throw new Error('Seeded test inventory is missing');

    const result = await inventory.reconcileCount(
      {
        locationId: current.locationId,
        skuId: current.skuId,
        expectedVersion: current.version,
        countedQuantity: current.onHand,
      },
      manager,
      'cycle-count-no-variance-0001',
    );

    expect(result.variance).toBe(0);
    expect(result.version).toBe(current.version);
  });

  it('records a nonzero cycle-count variance and updates the stock ledger', async () => {
    const current = (await inventory.listInventory({ locationId: 'loc-central' })).find(
      (row) => row.skuId === 'sku-bags',
    );
    if (!current) throw new Error('Seeded test inventory is missing');

    const result = await inventory.reconcileCount(
      {
        locationId: current.locationId,
        skuId: current.skuId,
        expectedVersion: current.version,
        countedQuantity: current.onHand + 1,
      },
      manager,
      'cycle-count-variance-0001',
    );
    const updated = (await inventory.listInventory({ locationId: current.locationId })).find(
      (row) => row.skuId === current.skuId,
    );
    const entry = (await inventory.listLedger(current.locationId, 100)).find(
      (row) => row.referenceId === result.id && row.movementType === 'count_adjustment',
    );

    expect(result.variance).toBe(1);
    expect(updated?.onHand).toBe(current.onHand + 1);
    expect(entry?.quantityDelta).toBe(1);
  });

  it('rejects a physical count below stock reserved for orders', async () => {
    await inventory.reserveStock(
      { locationId: 'loc-central', skuId: 'sku-coffee', quantity: 1 },
      manager,
      'cycle-count-floor-reserve-0001',
    );
    const current = (await inventory.listInventory({ locationId: 'loc-central' })).find(
      (row) => row.skuId === 'sku-coffee',
    );
    if (!current) throw new Error('Seeded test inventory is missing');

    await expect(
      inventory.reconcileCount(
        {
          locationId: current.locationId,
          skuId: current.skuId,
          expectedVersion: current.version,
          countedQuantity: current.reserved - 1,
        },
        manager,
        'cycle-count-below-reserved-0001',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('applies documented positive adjustments and rejects stock below reservations', async () => {
    const initial = (await inventory.listInventory({ locationId: 'loc-harbor' })).find(
      (row) => row.skuId === 'sku-soap',
    );
    if (!initial) throw new Error('Seeded test inventory is missing');

    const result = await inventory.adjustStock(
      { locationId: initial.locationId, skuId: initial.skuId, delta: 2, note: 'audit correction' },
      manager,
      'adjustment-positive-test-0001',
    );
    expect(result.onHand).toBe(initial.onHand + 2);

    await expect(
      inventory.adjustStock(
        { locationId: initial.locationId, skuId: initial.skuId, delta: -100, note: 'invalid count' },
        manager,
        'adjustment-reserved-floor-0001',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects same-location and unknown-location transfers', async () => {
    await expect(
      inventory.createTransfer(
        {
          fromLocationId: 'loc-central',
          toLocationId: 'loc-central',
          skuId: 'sku-coffee',
          quantity: 1,
        },
        manager,
        'transfer-same-location-0001',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      inventory.createTransfer(
        {
          fromLocationId: 'unknown-location',
          toLocationId: 'loc-north',
          skuId: 'sku-coffee',
          quantity: 1,
        },
        manager,
        'transfer-unknown-source-0001',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects reservations that exceed available stock', async () => {
    await expect(
      inventory.reserveStock(
        { locationId: 'loc-harbor', skuId: 'sku-soap', quantity: 100 },
        manager,
        'reservation-overdraw-test-0001',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not allow a transfer to consume reserved or unavailable units', async () => {
    await expect(
      inventory.createTransfer(
        {
          fromLocationId: 'loc-north',
          toLocationId: 'loc-harbor',
          skuId: 'sku-tea',
          quantity: 100,
        },
        manager,
        'transfer-overdraw-test-01',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('releases a reservation only once when separate requests race', async () => {
    const reservation = await inventory.reserveStock(
      { locationId: 'loc-north', skuId: 'sku-citrus', quantity: 1 },
      manager,
      'reservation-race-create-0001',
    );
    const before = (await inventory.listInventory({ locationId: 'loc-north' })).find(
      (row) => row.skuId === reservation.skuId,
    );
    if (!before) throw new Error('Seeded test inventory is missing');

    const results = await Promise.allSettled([
      inventory.releaseReservation(reservation.id, manager, 'reservation-race-release-0001'),
      inventory.releaseReservation(reservation.id, manager, 'reservation-race-release-0002'),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.find((result) => result.status === 'rejected');
    const after = (await inventory.listInventory({ locationId: 'loc-north' })).find(
      (row) => row.skuId === reservation.skuId,
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(after?.reserved).toBe(before.reserved - reservation.quantity);
  });

  it('allows only one concurrent reservation for the last available unit', async () => {
    const input = {
      locationId: 'loc-north',
      skuId: 'sku-citrus',
      quantity: 1,
    };
    await inventory.reserveStock({ ...input, quantity: 11 }, manager, 'reservation-last-unit-setup-0001');

    const beforeRace = (await inventory.listInventory({ locationId: input.locationId })).find(
      (row) => row.skuId === input.skuId,
    );
    expect(beforeRace).toBeDefined();
    if (!beforeRace) throw new Error('Seeded citrus inventory is missing');
    expect(beforeRace.onHand - beforeRace.reserved).toBe(1);

    const results = await Promise.allSettled([
      inventory.reserveStock(input, manager, 'reservation-last-unit-a'),
      inventory.reserveStock(input, manager, 'reservation-last-unit-b'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const rejected = results.find((result) => result.status === 'rejected');
    if (!rejected || rejected.status !== 'rejected') {
      throw new Error('Expected one competing reservation to be rejected');
    }
    expect(rejected.reason).toBeInstanceOf(ConflictException);

    const afterRace = (await inventory.listInventory({ locationId: input.locationId })).find(
      (row) => row.skuId === input.skuId,
    );
    expect(afterRace?.reserved).toBe(beforeRace.onHand);
  });
});
