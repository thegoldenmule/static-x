#!/usr/bin/env node
// Bin shim (not program source): the tool scans it and exempts the
// project files it imports.
await import(new URL('../src/shimmed.ts', import.meta.url).href);
