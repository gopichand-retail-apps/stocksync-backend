import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { RequireRoles } from '../auth/roles.decorator.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import type { SessionUser } from '../auth/auth.types.js';
import { parseInput } from '../common/parse-input.js';
import { InventoryService } from './inventory.service.js';
import {
  AdjustmentSchema,
  CreateTransferSchema,
  CycleCountSchema,
  IdempotencyKeySchema,
  InventoryQuerySchema,
  LedgerQuerySchema,
  ReceiveStockSchema,
  ReservationIdSchema,
  ReservationSchema,
  TransferIdSchema,
} from './inventory.schemas.js';

@Controller()
@UseGuards(SessionGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('locations')
  locations(@CurrentUser() user: SessionUser) {
    const locationId = user.role === 'associate' ? user.homeLocationId : undefined;
    return this.inventory.listLocations(locationId);
  }

  @Get('inventory')
  inventoryItems(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    const filters = parseInput(InventoryQuerySchema, query);
    return this.inventory.listInventory({
      ...filters,
      locationId: this.scopedLocation(user, filters.locationId),
    });
  }

  @Get('inventory/categories')
  categories() {
    return this.inventory.listCategories();
  }

  @Get('overview')
  overview(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    const filters = parseInput(InventoryQuerySchema.pick({ locationId: true }), query);
    return this.inventory.getOverview(this.scopedLocation(user, filters.locationId));
  }

  @Get('ledger')
  ledger(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    const filters = parseInput(LedgerQuerySchema, query);
    return this.inventory.listLedger(this.scopedLocation(user, filters.locationId), filters.limit);
  }

  @Get('transfers')
  transfers(@CurrentUser() user: SessionUser) {
    return this.inventory.listTransfers(user.role === 'associate' ? user.homeLocationId : undefined);
  }

  @Get('reservations')
  reservations(@CurrentUser() user: SessionUser, @Query('locationId') requestedLocation?: string) {
    const filters = parseInput(InventoryQuerySchema.pick({ locationId: true }), { locationId: requestedLocation });
    return this.inventory.listReservations(this.scopedLocation(user, filters.locationId));
  }

  @Post('receipts')
  @UseGuards(CsrfGuard, RolesGuard)
  @RequireRoles('associate', 'inventory_manager')
  receive(@Body() body: unknown, @CurrentUser() user: SessionUser, @Headers('idempotency-key') rawKey?: string) {
    const input = parseInput(ReceiveStockSchema, body);
    return this.inventory.receiveStock(input, user, this.idempotencyKey(rawKey));
  }

  @Post('transfers')
  @UseGuards(CsrfGuard, RolesGuard)
  @RequireRoles('inventory_manager')
  createTransfer(@Body() body: unknown, @CurrentUser() user: SessionUser, @Headers('idempotency-key') rawKey?: string) {
    const input = parseInput(CreateTransferSchema, body);
    return this.inventory.createTransfer(input, user, this.idempotencyKey(rawKey));
  }

  @Patch('transfers/:id/receive')
  @UseGuards(CsrfGuard, RolesGuard)
  @RequireRoles('associate', 'inventory_manager')
  receiveTransfer(
    @Param('id') rawId: string,
    @CurrentUser() user: SessionUser,
    @Headers('idempotency-key') rawKey?: string,
  ) {
    const transferId = parseInput(TransferIdSchema, rawId);
    return this.inventory.receiveTransfer(transferId, user, this.idempotencyKey(rawKey));
  }

  @Post('cycle-counts')
  @UseGuards(CsrfGuard, RolesGuard)
  @RequireRoles('associate', 'inventory_manager')
  reconcileCount(@Body() body: unknown, @CurrentUser() user: SessionUser, @Headers('idempotency-key') rawKey?: string) {
    const input = parseInput(CycleCountSchema, body);
    return this.inventory.reconcileCount(input, user, this.idempotencyKey(rawKey));
  }

  @Post('adjustments')
  @UseGuards(CsrfGuard, RolesGuard)
  @RequireRoles('inventory_manager')
  adjustStock(@Body() body: unknown, @CurrentUser() user: SessionUser, @Headers('idempotency-key') rawKey?: string) {
    const input = parseInput(AdjustmentSchema, body);
    return this.inventory.adjustStock(input, user, this.idempotencyKey(rawKey));
  }

  @Post('reservations')
  @UseGuards(CsrfGuard, RolesGuard)
  @RequireRoles('associate', 'inventory_manager')
  reserve(@Body() body: unknown, @CurrentUser() user: SessionUser, @Headers('idempotency-key') rawKey?: string) {
    const input = parseInput(ReservationSchema, body);
    return this.inventory.reserveStock(input, user, this.idempotencyKey(rawKey));
  }

  @Patch('reservations/:id/release')
  @UseGuards(CsrfGuard, RolesGuard)
  @RequireRoles('associate', 'inventory_manager')
  releaseReservation(
    @Param('id') rawId: string,
    @CurrentUser() user: SessionUser,
    @Headers('idempotency-key') rawKey?: string,
  ) {
    const reservationId = parseInput(ReservationIdSchema, rawId);
    return this.inventory.releaseReservation(reservationId, user, this.idempotencyKey(rawKey));
  }

  private scopedLocation(user: SessionUser, requestedLocation?: string): string | undefined {
    if (user.role !== 'associate') return requestedLocation;
    if (requestedLocation && requestedLocation !== user.homeLocationId) {
      throw new ForbiddenException({
        code: 'LOCATION_FORBIDDEN',
        message: 'Your account cannot access that location',
      });
    }
    return user.homeLocationId;
  }

  private idempotencyKey(value: string | undefined): string {
    return parseInput(IdempotencyKeySchema, value);
  }
}
