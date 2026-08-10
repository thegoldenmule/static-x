const { round } = Math;

export interface Shipment {
  id: string;
  weightKg: number;
}

export interface Carrier {
  name: string;
  ratePerKg: number;
}

function normalizeId(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Keyed on the normalized id so lookups survive sloppy input. */
export function shipmentKey(shipment: Shipment): string {
  return normalizeId(shipment.id);
}

export function carrierKey(carrier: Carrier): string {
  return normalizeId(carrier.name);
}

/** Rounded to the half kilo, the unit carriers actually bill in. */
export function billableWeight(shipment: Shipment): number {
  return round(shipment.weightKg * 2) / 2;
}
