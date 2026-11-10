import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { StockChangedEvent } from '../common/stock-events.service.js';
import { StockEventsService } from '../common/stock-events.service.js';
import type { SessionUser } from '../auth/auth.types.js';
import { InventoryTransactionService } from './inventory-transaction.service.js';

const MovementResultSchema = z.object({
  id: z.string().uuid(),
  locationId: z.string(),
  skuId: z.string(),
  quantity: z.number().int(),
  onHand: z.number().int(),
  version: z.number().int(),
  movementType: z.string(),
});

const CycleCountResultSchema = z.object({
  id: z.string().uuid(),
  locationId: z.string(),
  skuId: z.string(),
  expectedQuantity: z.number().int(),
  countedQuantity: z.number().int(),
  variance: z.number().int(),
  version: z.number().int(),
});

type MovementResult = z.infer<typeof MovementResultSchema>;
type CycleCountResult = z.infer<typeof CycleCountResultSchema>;

@Injectable()
export class InventoryStockService {
  constructor(
    private readonly transactions: InventoryTransactionService,
    private readonly events: StockEventsService,
  ) {}

  async receiveStock(
    input: { locationId: string; skuId: string; quantity: number; note?: string },
    user: SessionUser,
    key: string,
  ): Promise<MovementResult> {
    this.transactions.assertLocationAccess(user, input.locationId);
    const outcome = await this.transactions.runIdempotent({
      scope: `${user.id}:receipt`,
      key,
      payload: input,
      responseSchema: MovementResultSchema,
      operation: async (tx) => {
        const balance = await tx.query<{
          onHand: number;
          reserved: number;
          version: number;
        }>(
          `UPDATE inventory SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
           WHERE location_id = $1 AND sku_id = $2
           RETURNING on_hand AS "onHand", reserved, version`,
          [input.locationId, input.skuId, input.quantity],
        );
        const current = balance.rows[0];
        if (!current) throw new NotFoundException('Inventory item was not found');

        const id = randomUUID();
        await this.transactions.appendLedger(tx, {
          id,
          locationId: input.locationId,
          skuId: input.skuId,
          movementType: 'receipt',
          delta: input.quantity,
          referenceId: key,
          note: input.note,
          actorId: user.id,
        });
        return {
          id,
          locationId: input.locationId,
          skuId: input.skuId,
          quantity: input.quantity,
          onHand: current.onHand,
          version: current.version,
          movementType: 'receipt',
        };
      },
    });

    if (!outcome.replayed) {
      this.publishChange({
        locationId: outcome.value.locationId,
        skuId: outcome.value.skuId,
        version: outcome.value.version,
        eventType: 'receipt',
      });
    }
    return outcome.value;
  }

  async reconcileCount(
    input: {
      locationId: string;
      skuId: string;
      expectedVersion: number;
      countedQuantity: number;
    },
    user: SessionUser,
    key: string,
  ): Promise<CycleCountResult> {
    this.transactions.assertLocationAccess(user, input.locationId);
    const outcome = await this.transactions.runIdempotent({
      scope: `${user.id}:cycle-count`,
      key,
      payload: input,
      responseSchema: CycleCountResultSchema,
      operation: async (tx) => {
        const current = await this.transactions.getBalance(tx, input.locationId, input.skuId);
        if (!current) throw new NotFoundException('Inventory item was not found');
        if (current.version !== input.expectedVersion) {
          throw new ConflictException('Stock changed while the count was open; refresh before reconciling');
        }
        if (input.countedQuantity < current.reserved) {
          throw new ConflictException('Counted stock cannot be lower than units already reserved');
        }

        const variance = input.countedQuantity - current.onHand;
        const id = randomUUID();
        await tx.query(
          `INSERT INTO cycle_counts
            (id, location_id, sku_id, expected_quantity, counted_quantity, variance, actor_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, input.locationId, input.skuId, current.onHand, input.countedQuantity, variance, user.id],
        );
        if (variance === 0) {
          return {
            id,
            locationId: input.locationId,
            skuId: input.skuId,
            expectedQuantity: current.onHand,
            countedQuantity: input.countedQuantity,
            variance,
            version: current.version,
          };
        }

        const updated = await tx.query<{
          onHand: number;
          reserved: number;
          version: number;
        }>(
          `UPDATE inventory SET on_hand = $3, version = version + 1, updated_at = now()
           WHERE location_id = $1 AND sku_id = $2 AND version = $4 AND $3 >= reserved
           RETURNING on_hand AS "onHand", reserved, version`,
          [input.locationId, input.skuId, input.countedQuantity, input.expectedVersion],
        );
        const balance = updated.rows[0];
        if (!balance) throw new ConflictException('Stock changed; recount this item');
        await this.transactions.appendLedger(tx, {
          id: randomUUID(),
          locationId: input.locationId,
          skuId: input.skuId,
          movementType: 'count_adjustment',
          delta: variance,
          referenceId: id,
          actorId: user.id,
        });
        return {
          id,
          locationId: input.locationId,
          skuId: input.skuId,
          expectedQuantity: current.onHand,
          countedQuantity: input.countedQuantity,
          variance,
          version: balance.version,
        };
      },
    });

    if (!outcome.replayed && outcome.value.variance !== 0) {
      this.publishChange({
        locationId: outcome.value.locationId,
        skuId: outcome.value.skuId,
        version: outcome.value.version,
        eventType: 'cycle_count',
      });
    }
    return outcome.value;
  }

  async adjustStock(
    input: { locationId: string; skuId: string; delta: number; note: string },
    user: SessionUser,
    key: string,
  ): Promise<MovementResult> {
    this.transactions.assertLocationAccess(user, input.locationId);
    const outcome = await this.transactions.runIdempotent({
      scope: `${user.id}:adjustment`,
      key,
      payload: input,
      responseSchema: MovementResultSchema,
      operation: async (tx) => {
        const result = await tx.query<{
          onHand: number;
          reserved: number;
          version: number;
        }>(
          `UPDATE inventory SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
           WHERE location_id = $1 AND sku_id = $2 AND on_hand + $3 >= reserved
           RETURNING on_hand AS "onHand", reserved, version`,
          [input.locationId, input.skuId, input.delta],
        );
        const balance = result.rows[0];
        if (!balance) throw new ConflictException('Adjustment would reduce stock below reserved units');

        const id = randomUUID();
        await this.transactions.appendLedger(tx, {
          id,
          locationId: input.locationId,
          skuId: input.skuId,
          movementType: 'manual_adjustment',
          delta: input.delta,
          note: input.note,
          referenceId: key,
          actorId: user.id,
        });
        return {
          id,
          locationId: input.locationId,
          skuId: input.skuId,
          quantity: input.delta,
          onHand: balance.onHand,
          version: balance.version,
          movementType: 'manual_adjustment',
        };
      },
    });

    if (!outcome.replayed) {
      this.publishChange({
        locationId: outcome.value.locationId,
        skuId: outcome.value.skuId,
        version: outcome.value.version,
        eventType: 'adjustment',
      });
    }
    return outcome.value;
  }

  private publishChange(event: StockChangedEvent): void {
    this.events.publish(event);
  }
}
