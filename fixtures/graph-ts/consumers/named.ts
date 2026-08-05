// An extraRoots consumer: named imports here count as consumption of
// same-named project exports (syntactic, name-based matching).
import { unusedHelper } from 'graph-fixture';

export const cached = unusedHelper();
