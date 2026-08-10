// Member of the planted 2-file type-only cycle: both edges are
// `import type`, so the cycle is erased at runtime.
import type { BNode } from './type-b';

export interface ANode {
  child: BNode | null;
}
