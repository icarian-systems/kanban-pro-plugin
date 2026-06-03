/**
 * Dashboard (Pro) — public surface.
 *
 * The query engine is pure and lives in query.ts; the Bases adapter is an
 * optional runtime accelerator that returns [] when Bases is unavailable.
 */

export type { BasesAdapter, DashboardQuery, VaultIndexEntryShape } from './types';
export { executeQuery } from './query';
export { createBasesAdapter } from './basesAdapter';
