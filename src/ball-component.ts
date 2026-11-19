/**
 * Ball component — a grabbable, throwable ball resting on the Throw pedestal.
 *
 * Only its "home" resting position is stored as component data. The live
 * physics state (velocity, in-flight flag, prev position) is kept in a plain
 * Map inside ThrowSystem — it's transient per-frame bookkeeping, not scene data,
 * so it doesn't belong in the serialized ECS component.
 *
 * Scalar fields only (vector fields throw on setValue in elics 3.4.x).
 */
import { createComponent, Types } from '@iwsdk/core';

export const Ball = createComponent('Ball', {
  homeX: { type: Types.Float32, default: 0 },
  homeY: { type: Types.Float32, default: 1 },
  homeZ: { type: Types.Float32, default: -1 },
});
