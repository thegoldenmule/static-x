import { Invoice } from './invoice.js';
import { Order } from './order.js';
import { Receipt } from './receipt.js';

export function checkout(): string {
  const invoice = new Invoice();
  const order = new Order('sku-1', 2, 9.99);
  const amount = order.bill(invoice, 'rush');
  order.stampOn(invoice, 'packed');
  order.transfer(
    'shipped',
    invoice,
  );
  const receipt = new Receipt('r-1', amount);
  return `${receipt.render(24)} ${invoice.lines.join(',')}`;
}
