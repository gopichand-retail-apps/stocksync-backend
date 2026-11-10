import { z } from 'zod';

const identifier = z.string().trim().min(1).max(80);
const quantity = z.number().int().min(1).max(100_000);

export const InventoryQuerySchema = z
  .object({
    locationId: identifier.optional(),
    search: z.string().trim().max(80).optional(),
    category: z.string().trim().max(80).optional(),
  })
  .strict();

export const LedgerQuerySchema = z
  .object({
    locationId: identifier.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
  })
  .strict();

export const ReceiveStockSchema = z
  .object({
    locationId: identifier,
    skuId: identifier,
    quantity,
    note: z.string().trim().max(180).optional(),
  })
  .strict();

export const CreateTransferSchema = z
  .object({
    fromLocationId: identifier,
    toLocationId: identifier,
    skuId: identifier,
    quantity,
    note: z.string().trim().max(180).optional(),
  })
  .strict();

export const CycleCountSchema = z
  .object({
    locationId: identifier,
    skuId: identifier,
    expectedVersion: z.number().int().min(1),
    countedQuantity: z.number().int().min(0).max(100_000),
  })
  .strict();

export const AdjustmentSchema = z
  .object({
    locationId: identifier,
    skuId: identifier,
    delta: z
      .number()
      .int()
      .min(-100_000)
      .max(100_000)
      .refine((value) => value !== 0),
    note: z.string().trim().min(3).max(180),
  })
  .strict();

export const ReservationSchema = z
  .object({
    locationId: identifier,
    skuId: identifier,
    quantity,
    note: z.string().trim().max(180).optional(),
  })
  .strict();

export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/);
export const TransferIdSchema = z.string().uuid();
export const ReservationIdSchema = z.string().uuid();
