#!/usr/bin/env node
// Bin shim: registers the tsx loader so the TypeScript sources run
// directly, without a build step.
import { register } from 'tsx/esm/api';

register();
await import(new URL('./main.ts', import.meta.url).href);
