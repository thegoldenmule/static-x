import { Shipment, shipmentKey } from './models.js';

export function byKey(shipments: Shipment[]): Map<string, Shipment> {
  return new Map(shipments.map((shipment) => [shipmentKey(shipment), shipment]));
}
