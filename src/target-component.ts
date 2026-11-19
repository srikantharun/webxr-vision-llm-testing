/**
 * Target component — marks an entity as a poppable game target.
 *
 * Scalar fields only (safe with setValue/getValue; vector fields are not used
 * here on purpose, since setValue throws on vector fields in elics 3.4.x).
 */
import { createComponent, Types } from '@iwsdk/core';

export const Target = createComponent('Target', {
  points: { type: Types.Int32, default: 10 },
  // per-target phase offset so they don't all bob in unison
  phase: { type: Types.Float32, default: 0 },
  // the Y position the target bobs around
  baseY: { type: Types.Float32, default: 1.5 },
});
