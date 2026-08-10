export const WAREHOUSE_ID = 'W-1';

export function slot(position: number): string {
  return `${WAREHOUSE_ID}-${position}`;
}
