import { Injectable } from '@nestjs/common';
import type { SessionUser } from '../auth/auth.types.js';
import type { InventoryItem, LedgerEntry, LocationItem, ReservationItem, TransferItem } from './inventory.types.js';
import { InventoryReadService } from './inventory-read.service.js';
import { InventoryReservationService } from './inventory-reservation.service.js';
import { InventoryStockService } from './inventory-stock.service.js';
import { InventoryTransferService } from './inventory-transfer.service.js';

@Injectable()
export class InventoryService {
  constructor(
    private readonly reads: InventoryReadService,
    private readonly stock: InventoryStockService,
    private readonly transfers: InventoryTransferService,
    private readonly reservations: InventoryReservationService,
  ) {}

  listLocations(locationId?: string): Promise<LocationItem[]> {
    return this.reads.listLocations(locationId);
  }

  listInventory(filters: { locationId?: string; search?: string; category?: string }): Promise<InventoryItem[]> {
    return this.reads.listInventory(filters);
  }

  listCategories(): Promise<string[]> {
    return this.reads.listCategories();
  }

  getOverview(locationId?: string) {
    return this.reads.getOverview(locationId);
  }

  listLedger(locationId?: string, limit?: number): Promise<LedgerEntry[]> {
    return this.reads.listLedger(locationId, limit);
  }

  listTransfers(locationId?: string): Promise<TransferItem[]> {
    return this.reads.listTransfers(locationId);
  }

  listReservations(locationId?: string): Promise<ReservationItem[]> {
    return this.reads.listReservations(locationId);
  }

  receiveStock(input: Parameters<InventoryStockService['receiveStock']>[0], user: SessionUser, key: string) {
    return this.stock.receiveStock(input, user, key);
  }

  reconcileCount(input: Parameters<InventoryStockService['reconcileCount']>[0], user: SessionUser, key: string) {
    return this.stock.reconcileCount(input, user, key);
  }

  adjustStock(input: Parameters<InventoryStockService['adjustStock']>[0], user: SessionUser, key: string) {
    return this.stock.adjustStock(input, user, key);
  }

  createTransfer(input: Parameters<InventoryTransferService['createTransfer']>[0], user: SessionUser, key: string) {
    return this.transfers.createTransfer(input, user, key);
  }

  receiveTransfer(transferId: string, user: SessionUser, key: string) {
    return this.transfers.receiveTransfer(transferId, user, key);
  }

  reserveStock(input: Parameters<InventoryReservationService['reserveStock']>[0], user: SessionUser, key: string) {
    return this.reservations.reserveStock(input, user, key);
  }

  releaseReservation(reservationId: string, user: SessionUser, key: string) {
    return this.reservations.releaseReservation(reservationId, user, key);
  }
}
