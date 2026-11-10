import { Injectable } from '@nestjs/common';
import type { SessionUser } from '../auth/auth.types.js';

export const ALL_INVENTORY_ROOM = 'stocksync:locations:all';

export function inventoryLocationRoom(locationId: string): string {
  return `stocksync:location:${locationId}`;
}

export function inventorySubscriptionRooms(user: SessionUser): string[] {
  return user.role === 'associate' ? [inventoryLocationRoom(user.homeLocationId)] : [ALL_INVENTORY_ROOM];
}

export function inventoryEventRooms(locationId: string): string[] {
  return [inventoryLocationRoom(locationId), ALL_INVENTORY_ROOM];
}

export interface StockChangedEvent {
  locationId: string;
  skuId: string;
  version: number;
  eventType: 'receipt' | 'transfer' | 'cycle_count' | 'adjustment' | 'reservation';
}

@Injectable()
export class StockEventsService {
  private publisher: ((event: StockChangedEvent) => void) | undefined;

  attachPublisher(publisher: (event: StockChangedEvent) => void): void {
    this.publisher = publisher;
  }

  publish(event: StockChangedEvent): void {
    this.publisher?.(event);
  }
}
