export interface Payload {
  id: string;
  size: number;
}

export function parsePayload(raw: string): Payload {
  return JSON.parse(raw) as Payload;
}

export function stashValue(value: string): unknown {
  return value as any;
}

export function smuggleValue(value: string): Payload {
  return value as unknown as Payload;
}

export const LEVELS = ['low', 'medium', 'high'] as const;

export const CAST_NOTE = 'treat this as any other string';
