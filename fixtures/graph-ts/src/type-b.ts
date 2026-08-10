// Other member of the planted type-only cycle.
import type { ANode } from './type-a';

export interface BNode {
  parent: ANode | null;
}
