import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { StockEventsService } from '../common/stock-events.service.js';
import type { SessionUser } from '../auth/auth.types.js';
import { InventoryTransactionService } from './inventory-transaction.service.js';

const ReservationResultSchema = z.object({
  id: z.string().uuid(),
  locationId: z.string(),
  skuId: z.string(),
  quantity: z.number().int(),
  status: z.literal('active'),
  available: z.number().int(),
  version: z.number().int(),
});

const ReleaseResultSchema = z.object({
  id: z.string().uuid(),
  locationId: z.string(),
  skuId: z.string(),
  status: z.literal('released'),
  version: z.number().int(),
});

type ReservationResult = z.infer<typeof ReservationResultSchema>;
type ReleaseResult = z.infer<typeof ReleaseResultSchema>;

@Injectable()
export class InventoryReservationService {
  constructor(
    private readonly transactions: InventoryTransactionService,
    private readonly events: StockEventsService,
  ) {}

  async reserveStock(
    input: { locationId: string; skuId: string; quantity: number; note?: string },
    user: SessionUser,
    key: string,
  ): Promise<ReservationResult> {
    this.transactions.assertLocationAccess(user, input.locationId);
    const outcome = await this.transactions.runIdempotent({
      scope: `${user.id}:reservation:create`,
      key,
      payload: input,
      responseSchema: ReservationResultSchema,
      operation: async (tx) => {
        const result = await tx.query<{
          onHand: number;
          reserved: number;
          version: number;
        }>(
          `UPDATE inventory SET reserved = reserved + $3, version = version + 1, updated_at = now()
           WHERE location_id = $1 AND sku_id = $2 AND on_hand - reserved >= $3
           RETURNING on_hand AS "onHand", reserved, version`,
          [input.locationId, input.skuId, input.quantity],
        );
        const balance = result.rows[0];
        if (!balance) throw new ConflictException('There is not enough available stock to reserve');

        const id = crypto.randomUUID();
        await tx.query(
          `INSERT INTO reservations (id, location_id, sku_id, quantity, status, note, created_by)
           VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
          [id, input.locationId, input.skuId, input.quantity, input.note ?? null, user.id],
        );
        return {
          id,
          locationId: input.locationId,
          skuId: input.skuId,
          quantity: input.quantity,
          status: 'active' as const,
          available: balance.onHand - balance.reserved,
          version: balance.version,
        };
      },
    });

    if (!outcome.replayed) {
      this.events.publish({
        locationId: outcome.value.locationId,
        skuId: outcome.value.skuId,
        version: outcome.value.version,
        eventType: 'reservation',
      });
    }
    return outcome.value;
  }

  async releaseReservation(reservationId: string, user: SessionUser, key: string): Promise<ReleaseResult> {
    const outcome = await this.transactions.runIdempotent({
      scope: `${user.id}:reservation:release:${reservationId}`,
      key,
      payload: { reservationId },
      responseSchema: ReleaseResultSchema,
      operation: async (tx) => {
        const result = await tx.query<{
          id: string;
          location_id: string;
          sku_id: string;
          quantity: number;
          status: string;
        }>('SELECT id, location_id, sku_id, quantity, status FROM reservations WHERE id = $1 FOR UPDATE', [
          reservationId,
        ]);
        const reservation = result.rows[0];
        if (!reservation) throw new NotFoundException('Reservation was not found');
        this.transactions.assertLocationAccess(user, reservation.location_id);
        if (reservation.status !== 'active') throw new ConflictException('Reservation is already released');

        const balanceResult = await tx.query<{
          onHand: number;
          reserved: number;
          version: number;
        }>(
          `UPDATE inventory SET reserved = reserved - $3, version = version + 1, updated_at = now()
           WHERE location_id = $1 AND sku_id = $2 AND reserved >= $3
           RETURNING on_hand AS "onHand", reserved, version`,
          [reservation.location_id, reservation.sku_id, reservation.quantity],
        );
        const balance = balanceResult.rows[0];
        if (!balance) throw new ConflictException('Reservation could not be released');
        const release = await tx.query<{ id: string }>(
          `UPDATE reservations SET status = 'released', released_at = now()
           WHERE id = $1 AND status = 'active' RETURNING id`,
          [reservationId],
        );
        if (!release.rows[0]) throw new ConflictException('Reservation is already released');
        return {
          id: reservation.id,
          locationId: reservation.location_id,
          skuId: reservation.sku_id,
          status: 'released' as const,
          version: balance.version,
        };
      },
    });

    if (!outcome.replayed) {
      this.events.publish({
        locationId: outcome.value.locationId,
        skuId: outcome.value.skuId,
        version: outcome.value.version,
        eventType: 'reservation',
      });
    }
    return outcome.value;
  }
}
