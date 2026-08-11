import { Gauge } from './gauge.js';
import { Meter } from './meter.js';
import { Report } from './report.js';

export function summarize(meter: Meter, gauge: Gauge, report: Report): string {
  meter.level = meter.level + 1;
  gauge.reading += 2;
  const rows = report.getRows(1).join(',');
  return `${report.getTitle()} ${meter.level} ${gauge.reading} ${gauge.id} ${rows} ${meter.unit}`;
}
