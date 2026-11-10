import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import type { PGlite } from '@electric-sql/pglite';

const locations = [
  { id: 'loc-central', code: 'CTR-01', name: 'Central Market', region: 'Bay Area' },
  { id: 'loc-north', code: 'NTH-02', name: 'Northline Store', region: 'North Bay' },
  { id: 'loc-harbor', code: 'HBR-03', name: 'Harbor Point', region: 'Coastal' },
];

const skus = [
  {
    id: 'sku-coffee',
    sku: 'BEV-1042',
    barcode: '850010420001',
    name: 'House Blend Coffee',
    category: 'Grocery',
    unit: 'bag',
    threshold: 24,
    accent: 'copper',
  },
  {
    id: 'sku-oat-milk',
    sku: 'BEV-2088',
    barcode: '850020880002',
    name: 'Oat Milk, Original',
    category: 'Dairy & Alt',
    unit: 'carton',
    threshold: 18,
    accent: 'sage',
  },
  {
    id: 'sku-bags',
    sku: 'SUP-0310',
    barcode: '850003100003',
    name: 'Recycled Paper Bags',
    category: 'Supplies',
    unit: 'pack',
    threshold: 12,
    accent: 'blue',
  },
  {
    id: 'sku-citrus',
    sku: 'PRD-1175',
    barcode: '850011750004',
    name: 'Seasonal Citrus Box',
    category: 'Produce',
    unit: 'box',
    threshold: 10,
    accent: 'yellow',
  },
  {
    id: 'sku-tea',
    sku: 'BEV-3074',
    barcode: '850030740005',
    name: 'Jasmine Green Tea',
    category: 'Grocery',
    unit: 'case',
    threshold: 8,
    accent: 'green',
  },
  {
    id: 'sku-soap',
    sku: 'HOM-0812',
    barcode: '850008120006',
    name: 'Cedar Hand Soap',
    category: 'Home',
    unit: 'case',
    threshold: 6,
    accent: 'rose',
  },
];

const demoUsers = [
  {
    id: 'user-associate',
    email: 'associate@stocksync.test',
    displayName: 'Jamie Lee',
    role: 'associate',
    locationId: 'loc-central',
  },
  {
    id: 'user-manager',
    email: 'manager@stocksync.test',
    displayName: 'Morgan Patel',
    role: 'inventory_manager',
    locationId: 'loc-central',
  },
  {
    id: 'user-auditor',
    email: 'auditor@stocksync.test',
    displayName: 'Taylor Kim',
    role: 'auditor',
    locationId: 'loc-central',
  },
];

const openingQuantities: Record<string, number[]> = {
  'sku-coffee': [42, 17, 26],
  'sku-oat-milk': [34, 9, 22],
  'sku-bags': [16, 23, 8],
  'sku-citrus': [19, 12, 7],
  'sku-tea': [14, 6, 11],
  'sku-soap': [9, 7, 4],
};

export async function seedDemoData(database: PGlite): Promise<void> {
  const countResult = await database.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM users');
  if ((countResult.rows[0]?.count ?? 0) > 0) return;

  const password = process.env.STOCKSYNC_DEMO_PASSWORD ?? 'stock-demo-only';
  const passwordHashes = await Promise.all(demoUsers.map(() => hash(password)));

  await database.transaction(async (tx) => {
    for (const location of locations) {
      await tx.query('INSERT INTO locations (id, code, name, region) VALUES ($1, $2, $3, $4)', [
        location.id,
        location.code,
        location.name,
        location.region,
      ]);
    }

    for (let index = 0; index < demoUsers.length; index += 1) {
      const user = demoUsers[index];
      const passwordHash = passwordHashes[index];
      if (!user || !passwordHash) continue;

      await tx.query(
        `INSERT INTO users (id, email, display_name, role, password_hash, home_location_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, user.email, user.displayName, user.role, passwordHash, user.locationId],
      );
    }

    for (const sku of skus) {
      await tx.query(
        `INSERT INTO skus (id, sku, barcode, name, category, unit, low_stock_threshold, accent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [sku.id, sku.sku, sku.barcode, sku.name, sku.category, sku.unit, sku.threshold, sku.accent],
      );
    }

    for (const [skuIndex, sku] of skus.entries()) {
      const quantities = openingQuantities[sku.id] ?? [];
      for (const [locationIndex, location] of locations.entries()) {
        const quantity = quantities[locationIndex];
        if (quantity === undefined) continue;

        await tx.query(
          `INSERT INTO inventory (location_id, sku_id, on_hand)
           VALUES ($1, $2, $3)`,
          [location.id, sku.id, quantity],
        );
        await tx.query(
          `INSERT INTO stock_ledger
            (id, location_id, sku_id, movement_type, quantity_delta, reference_id, actor_id)
           VALUES ($1, $2, $3, 'opening_stock', $4, $5, 'user-manager')`,
          [randomUUID(), location.id, sku.id, quantity, `opening-${skuIndex}-${locationIndex}`],
        );
      }
    }
  });
}
