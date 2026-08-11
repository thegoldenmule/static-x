import { Label } from './label.js';

export function tags(label: Label): string[] {
  return [Label.render('#', label), Label.render('@')];
}
