// An extraRoots consumer that imports nothing from the project; its
// presence still drops value-export confidence to medium.
import { somethingElse } from 'some-other-package';

export const value = somethingElse;
