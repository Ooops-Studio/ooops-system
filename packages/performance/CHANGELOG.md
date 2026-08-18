# @ooopsstudio/performance

## 0.9.2

### Patch Changes

- Keep event-loop warning state through the informational recovery band so p95 threshold flapping does not emit repeated warning and recovery logs.

- Updated dependencies:
  - @ooopsstudio/core@0.9.1

## 0.9.1

### Patch Changes

- Evaluate event-loop saturation from a rolling p95 window, emit bounded transition and recovery notifications, and preserve per-sample lag metrics.

- Updated dependencies:
  - @ooopsstudio/core@0.9.1
