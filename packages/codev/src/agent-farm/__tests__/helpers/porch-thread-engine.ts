/**
 * Spec 146 Phase 9, issue #179 item 1: the engine moved into production source at
 * `agent-farm/porch-thread-engine.ts`. This file stays only so existing tests keep
 * their import path, and re-exports rather than duplicating — a second copy is how
 * the tested engine and the shipped one drift apart.
 */
export {
  createPorchThreadEngine,
  type PorchThreadEngineOptions,
} from '../../porch-thread-engine.js';
