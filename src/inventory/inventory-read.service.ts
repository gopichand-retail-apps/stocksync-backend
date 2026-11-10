import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { InventoryItem, LedgerEntry, LocationItem, ReservationItem, TransferItem } from './inventory.types.js';

@Injectable()
export class InventoryReadService {
  constructor(private readonly database: DatabaseService) {}

  async listLocations(locationId?: string): Promise<LocationItem[]> {
    const result = await this.database.query<LocationItem>(
      `SELECT id, code, name, region FROM locations
       WHERE is_active = TRUE AND ($1::text IS NULL OR id = $1)
       ORDER BY name`,
      [locationId ?? null],
    );
    return result.rows;
  }

  async listInventory(filters: { locationId?: string; search?: string; category?: string }): Promise<InventoryItem[]> {
    const result = await this.database.query<InventoryItem>(
      `SELECT
         s.id AS "skuId", s.sku, s.barcode, s.name, s.category, s.unit,
         s.low_stock_threshold AS threshold, s.accent,
         l.id AS "locationId", l.code AS "locationCode", l.name AS "locationName",
         i.on_hand AS "onHand", i.reserved, i.on_hand - i.reserved AS available,
         i.version, i.updated_at AS "updatedAt"
       FROM inventory i
       JOIN skus s ON s.id = i.sku_id
       JOIN locations l ON l.id = i.location_id
       WHERE ($1::text IS NULL OR l.id = $1)
         AND ($2::text = '' OR s.name ILIKE '%' || $2 || '%' OR s.sku ILIKE '%' || $2 || '%'
           OR s.barcode ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR s.category = $3)
       ORDER BY (i.on_hand - i.reserved <= s.low_stock_threshold) DESC, s.name, l.name`,
      [filters.locationId ?? null, filters.search ?? '', filters.category ?? null],
    );
    return result.rows;
  }

  async listCategories(): Promise<string[]> {
    const result = await this.database.query<{ category: string }>(
      'SELECT DISTINCT category FROM skus ORDER BY category',
    );
    return result.rows.map((row) => row.category);
  }

  async getOverview(locationId?: string) {
    const [summary, inventory, activity, activeTransfers] = await Promise.all([
      this.database.query<{
        skuCount: number;
        unitsOnHand: number;
        reservedUnits: number;
        lowStockCount: number;
      }>(
        `SELECT
           COUNT(DISTINCT i.sku_id)::integer AS "skuCount",
           COALESCE(SUM(i.on_hand), 0)::integer AS "unitsOnHand",
           COALESCE(SUM(i.reserved), 0)::integer AS "reservedUnits",
           COUNT(*) FILTER (
             WHERE i.on_hand - i.reserved <= s.low_stock_threshold
           )::integer AS "lowStockCount"
         FROM inventory i JOIN skus s ON s.id = i.sku_id
         WHERE ($1::text IS NULL OR i.location_id = $1)`,
        [locationId ?? null],
      ),
      this.listInventory({ locationId }),
      this.listLedger(locationId, 8),
      this.database.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count FROM transfers
         WHERE status = 'in_transit'
           AND ($1::text IS NULL OR from_location_id = $1 OR to_location_id = $1)`,
        [locationId ?? null],
      ),
    ]);

    const metrics = summary.rows[0] ?? {
      skuCount: 0,
      unitsOnHand: 0,
      reservedUnits: 0,
      lowStockCount: 0,
    };
    return {
      metrics: { ...metrics, activeTransfers: activeTransfers.rows[0]?.count ?? 0 },
      lowStock: inventory.filter((item) => item.available <= item.threshold).slice(0, 5),
      activity,
    };
  }

  async listLedger(locationId?: string, limit = 40): Promise<LedgerEntry[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const result = await this.database.query<LedgerEntry>(
      `SELECT
         entry.id, entry.location_id AS "locationId", location.name AS "locationName",
         entry.sku_id AS "skuId", sku.sku, sku.name AS "productName",
         entry.movement_type AS "movementType", entry.quantity_delta AS "quantityDelta",
         entry.reference_id AS "referenceId", entry.note, actor.display_name AS "actorName",
         entry.created_at AS "createdAt"
       FROM stock_ledger entry
       JOIN locations location ON location.id = entry.location_id
       JOIN skus sku ON sku.id = entry.sku_id
       JOIN users actor ON actor.id = entry.actor_id
       WHERE ($1::text IS NULL OR entry.location_id = $1)
       ORDER BY entry.created_at DESC LIMIT $2`,
      [locationId ?? null, boundedLimit],
    );
    return result.rows;
  }

  async listTransfers(locationId?: string): Promise<TransferItem[]> {
    const result = await this.database.query<TransferItem>(
      `SELECT
         transfer.id, transfer.sku_id AS "skuId", sku.sku, sku.name AS "productName",
         transfer.from_location_id AS "fromLocationId", source.name AS "fromLocationName",
         transfer.to_location_id AS "toLocationId", destination.name AS "toLocationName",
         transfer.quantity, transfer.status, transfer.note,
         actor.display_name AS "createdBy", transfer.created_at AS "createdAt",
         transfer.received_at AS "receivedAt"
       FROM transfers transfer
       JOIN skus sku ON sku.id = transfer.sku_id
       JOIN locations source ON source.id = transfer.from_location_id
       JOIN locations destination ON destination.id = transfer.to_location_id
       JOIN users actor ON actor.id = transfer.created_by
       WHERE ($1::text IS NULL OR transfer.from_location_id = $1 OR transfer.to_location_id = $1)
       ORDER BY transfer.created_at DESC LIMIT 100`,
      [locationId ?? null],
    );
    return result.rows;
  }

  async listReservations(locationId?: string): Promise<ReservationItem[]> {
    const result = await this.database.query<ReservationItem>(
      `SELECT
         reservation.id, reservation.location_id AS "locationId", location.name AS "locationName",
         reservation.sku_id AS "skuId", sku.sku, sku.name AS "productName",
         reservation.quantity, reservation.status, reservation.note,
         actor.display_name AS "createdBy", reservation.created_at AS "createdAt"
       FROM reservations reservation
       JOIN locations location ON location.id = reservation.location_id
       JOIN skus sku ON sku.id = reservation.sku_id
       JOIN users actor ON actor.id = reservation.created_by
       WHERE reservation.status = 'active'
         AND ($1::text IS NULL OR reservation.location_id = $1)
       ORDER BY reservation.created_at DESC LIMIT 100`,
      [locationId ?? null],
    );
    return result.rows;
  }
}
