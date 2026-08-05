import { aliasedFn } from '@app/aliased';
import * as geometry from './geometry';

export function add(a: number, b: number): number {
  return aliasedFn(a) + geometry.area(b);
}
