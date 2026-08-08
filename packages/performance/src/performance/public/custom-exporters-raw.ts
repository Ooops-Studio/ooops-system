export type {PerformanceEventExporterPort} from '@ooopsstudio/core/ports/performance'
export type {PerformanceEventRecord} from '@ooopsstudio/core/contracts/performance'

import type {PerformanceEventExporterPort} from '@ooopsstudio/core/ports/performance'

/** Type-safe identity helper for custom raw performance exporters. */
export const definePerformanceEventExporter = <T extends PerformanceEventExporterPort>(exporter: T): T => exporter
