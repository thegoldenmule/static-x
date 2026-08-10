/**
 * Both imports the types and re-exports them from the same module. The
 * re-export sits flush against the import on purpose: the engine's new
 * import is a zero-length insertion at exactly the re-export's start
 * offset, so treating "touching" as "overlapping" would skip this
 * statement and put the bug back.
 */
import type { Carrier, Shipment } from './models.js';
export type { Carrier, Shipment } from './models.js';

export interface Desk {
  route(shipment: Shipment, carrier: Carrier): string;
}
