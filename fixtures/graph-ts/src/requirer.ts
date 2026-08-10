// CommonJS-style consumer: the bare require() call must contribute a
// graph edge that keeps req-target.ts alive. This file itself is
// imported by nothing, so it stays a planted dead file.
declare const require: (id: string) => unknown;
require('./req-target');
export {};
