export interface InventoryItem extends Record<string, unknown> {
  skuId: string;
  sku: string;
  barcode: string;
  name: string;
  category: string;
  unit: string;
  threshold: number;
  accent: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  onHand: number;
  reserved: number;
  available: number;
  version: number;
  updatedAt: string;
}

export interface LocationItem extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  region: string;
}

export interface LedgerEntry extends Record<string, unknown> {
  id: string;
  locationId: string;
  locationName: string;
  skuId: string;
  sku: string;
  productName: string;
  movementType: string;
  quantityDelta: number;
  referenceId: string | null;
  note: string | null;
  actorName: string;
  createdAt: string;
}

export interface TransferItem extends Record<string, unknown> {
  id: string;
  skuId: string;
  sku: string;
  productName: string;
  fromLocationId: string;
  fromLocationName: string;
  toLocationId: string;
  toLocationName: string;
  quantity: number;
  status: 'in_transit' | 'received' | 'cancelled';
  note: string | null;
  createdBy: string;
  createdAt: string;
  receivedAt: string | null;
}

export interface ReservationItem extends Record<string, unknown> {
  id: string;
  locationId: string;
  locationName: string;
  skuId: string;
  sku: string;
  productName: string;
  quantity: number;
  status: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}
