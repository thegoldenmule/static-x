import { Money } from './money.js';

export function applyAll(amounts: Money[]): Money[] {
  return amounts.map(Money.bump);
}
