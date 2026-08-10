import { Shipment, billableWeight } from './models.js';

export function totalWeight(shipments: Shipment[]): number {
  return shipments.reduce((sum, shipment) => sum + billableWeight(shipment), 0);
}
