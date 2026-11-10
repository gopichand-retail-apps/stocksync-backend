import { describe, expect, it } from 'vitest';
import type { SessionUser } from '../auth/auth.types.js';
import {
  ALL_INVENTORY_ROOM,
  inventoryEventRooms,
  inventoryLocationRoom,
  inventorySubscriptionRooms,
} from './stock-events.service.js';

const associate: SessionUser = {
  id: 'user-associate',
  email: 'associate@stocksync.test',
  displayName: 'Jamie Lee',
  role: 'associate',
  homeLocationId: 'loc-central',
};

describe('StockSync live event room access', () => {
  it('limits associates to their home location', () => {
    expect(inventorySubscriptionRooms(associate)).toEqual([inventoryLocationRoom('loc-central')]);
  });

  it('allows manager and auditor subscriptions to all inventory locations', () => {
    expect(inventorySubscriptionRooms({ ...associate, role: 'inventory_manager' })).toEqual([ALL_INVENTORY_ROOM]);
    expect(inventorySubscriptionRooms({ ...associate, role: 'auditor' })).toEqual([ALL_INVENTORY_ROOM]);
  });

  it('publishes changes to the changed location and authorized global readers', () => {
    expect(inventoryEventRooms('loc-north')).toEqual([inventoryLocationRoom('loc-north'), ALL_INVENTORY_ROOM]);
  });
});
