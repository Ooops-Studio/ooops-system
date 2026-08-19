# @ooopsstudio/performance

## 0.9.4

### Patch Changes

- Publish the stabilized event-loop saturation monitor with consumer-safe workspace dependency ranges.

### Updated dependencies

- @ooopsstudio/core@0.9.1

## 0.9.3

### Patch Changes

- Require consecutive rolling-p95 observations before event-loop saturation entry, escalation, and recovery so short-lived threshold oscillations do not generate repeated operational logs.

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
