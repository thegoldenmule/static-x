// The star re-export keeps every export of star-source alive; barrel's
// own export is consumed by tasks.ts.
export * from './star-source';
export const barrelOwn = 'barrel';
