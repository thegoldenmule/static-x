import type { Carrier, Shipment } from './models.js';

/**
 * Both imports the types and re-exports them from the same module —
 * the engine rewrites the import and leaves the re-export behind.
 */
export type { Carrier, Shipment } from './models.js';

export interface Desk {
  route(shipment: Shipment, carrier: Carrier): string;
}
