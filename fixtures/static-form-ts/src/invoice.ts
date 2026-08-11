import { Money } from './money.js';

export function withTax(net: Money): Money {
  return Money.scale(net, 1.2);
}

export function doubled(net: Money): Money {
  return Money.scale(net, 2);
}
