import type { OrderId } from './types.js';

export function ship(id: OrderId): string {
  return String(id);
}

export function track(id: OrderId): string {
  return ship(id);
}
