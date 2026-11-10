import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { StockEventsService } from '../common/stock-events.service.js';
import type { SessionUser } from '../auth/auth.types.js';
import { InventoryTransactionService } from './inventory-transaction.service.js';

const TransferResultSchema = z.object({
  id: z.string().uuid(),
  skuId: z.string(),
  fromLocationId: z.string(),
  toLocationId: z.string(),
  quantity: z.number().int(),
  status: z.literal('in_transit'),
  fromOnHand: z.number().int(),
  version: z.number().int(),
});

const TransferReceiptResultSchema = z.object({
  id: z.string().uuid(),
  locationId: z.string(),
  skuId: z.string(),
  quantity: z.number().int(),
  status: z.literal('received'),
  onHand: z.number().int(),
  version: z.number().int(),
});

type TransferResult = z.infer<typeof TransferResultSchema>;
type TransferReceiptResult = z.infer<typeof TransferReceiptResultSchema>;

@Injectable()
export class InventoryTransferService {
  constructor(
    private readonly transactions: InventoryTransactionService,
    private readonly events: StockEventsService,
  ) {}

  async createTransfer(
    input: {
      fromLocationId: string;
      toLocationId: string;
      skuId: string;
      quantity: number;
      note?: string;
    },
    user: SessionUser,
    key: string,
  ): Promise<TransferResult> {
    if (input.fromLocationId === input.toLocationId) {
      throw new ConflictException('Choose two different locations');
    }
    const outcome = await this.transactions.runIdempotent({
      scope: `${user.id}:transfer:create`,
      key,
      payload: input,
      responseSchema: TransferResultSchema,
      operation: async (tx) => {
        const source = await this.transactions.getBalance(tx, input.fromLocationId, input.skuId);
        if (!source) throw new NotFoundException('Source inventory was not found');
        if (source.onHand - source.reserved < input.quantity) {
          throw new ConflictException('There is not enough available stock for this transfer');
        }

        const updated = await tx.query<{
          onHand: number;
          reserved: number;
          version: number;
        }>(
          `UPDATE inventory SET on_hand = on_hand - $3, version = version + 1, updated_at = now()
           WHERE location_id = $1 AND sku_id = $2 AND on_hand - reserved >= $3
           RETURNING on_hand AS "onHand", reserved, version`,
          [input.fromLocationId, input.skuId, input.quantity],
        );
        const balance = updated.rows[0];
        if (!balance) throw new ConflictException('Stock changed; refresh and try again');

        const id = randomUUID();
        await tx.query(
          `INSERT INTO transfers
            (id, sku_id, from_location_id, to_location_id, quantity, status, note, created_by)
           VALUES ($1, $2, $3, $4, $5, 'in_transit', $6, $7)`,
          [id, input.skuId, input.fromLocationId, input.toLocationId, input.quantity, input.note ?? null, user.id],
        );
        await this.transactions.appendLedger(tx, {
          id: randomUUID(),
          locationId: input.fromLocationId,
          skuId: input.skuId,
          movementType: 'transfer_out',
          delta: -input.quantity,
          referenceId: id,
          note: input.note,
          actorId: user.id,
        });
        return {
          id,
          skuId: input.skuId,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          quantity: input.quantity,
          status: 'in_transit' as const,
          fromOnHand: balance.onHand,
          version: balance.version,
        };
      },
    });

    if (!outcome.replayed) {
      this.events.publish({
        locationId: outcome.value.fromLocationId,
        skuId: outcome.value.skuId,
        version: outcome.value.version,
        eventType: 'transfer',
      });
    }
    return outcome.value;
  }

  async receiveTransfer(transferId: string, user: SessionUser, key: string): Promise<TransferReceiptResult> {
    const outcome = await this.transactions.runIdempotent({
      scope: `${user.id}:transfer:receive:${transferId}`,
      key,
      payload: { transferId },
      responseSchema: TransferReceiptResultSchema,
      operation: async (tx) => {
        const transferResult = await tx.query<{
          id: string;
          sku_id: string;
          to_location_id: string;
          quantity: number;
          status: string;
        }>(
          `SELECT id, sku_id, to_location_id, quantity, status
           FROM transfers WHERE id = $1 FOR UPDATE`,
          [transferId],
        );
        const transfer = transferResult.rows[0];
        if (!transfer) throw new NotFoundException('Transfer was not found');
        this.transactions.assertLocationAccess(user, transfer.to_location_id);
        if (transfer.status !== 'in_transit') {
          throw new ConflictException('This transfer has already been resolved');
        }

        const balance = await tx.query<{
          onHand: number;
          reserved: number;
          version: number;
        }>(
          `UPDATE inventory SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
           WHERE location_id = $1 AND sku_id = $2
           RETURNING on_hand AS "onHand", reserved, version`,
          [transfer.to_location_id, transfer.sku_id, transfer.quantity],
        );
        const current = balance.rows[0];
        if (!current) throw new NotFoundException('Destination inventory was not found');
        const resolution = await tx.query<{ id: string }>(
          `UPDATE transfers SET status = 'received', received_by = $2, received_at = now()
           WHERE id = $1 AND status = 'in_transit' RETURNING id`,
          [transferId, user.id],
        );
        if (!resolution.rows[0]) throw new ConflictException('This transfer has already been resolved');
        await this.transactions.appendLedger(tx, {
          id: randomUUID(),
          locationId: transfer.to_location_id,
          skuId: transfer.sku_id,
          movementType: 'transfer_in',
          delta: transfer.quantity,
          referenceId: transferId,
          actorId: user.id,
        });
        return {
          id: transferId,
          locationId: transfer.to_location_id,
          skuId: transfer.sku_id,
          quantity: transfer.quantity,
          status: 'received' as const,
          onHand: current.onHand,
          version: current.version,
        };
      },
    });

    if (!outcome.replayed) {
      this.events.publish({
        locationId: outcome.value.locationId,
        skuId: outcome.value.skuId,
        version: outcome.value.version,
        eventType: 'transfer',
      });
    }
    return outcome.value;
  }
}
