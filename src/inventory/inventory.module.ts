import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StockEventsService } from '../common/stock-events.service.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryReadService } from './inventory-read.service.js';
import { InventoryReservationService } from './inventory-reservation.service.js';
import { InventoryStockService } from './inventory-stock.service.js';
import { InventoryService } from './inventory.service.js';
import { InventoryTransactionService } from './inventory-transaction.service.js';
import { InventoryTransferService } from './inventory-transfer.service.js';

@Module({
  imports: [AuthModule],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    InventoryReadService,
    InventoryTransactionService,
    InventoryStockService,
    InventoryTransferService,
    InventoryReservationService,
    StockEventsService,
  ],
  exports: [StockEventsService],
})
export class InventoryModule {}
