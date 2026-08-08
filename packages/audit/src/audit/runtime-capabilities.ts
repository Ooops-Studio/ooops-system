import type {ManagedAudit} from '@ooopsstudio/core/ports/audit'

export type AuditTelemetryEvent =
	| {readonly kind: 'active'; readonly count: number}
	| {readonly kind: 'recorded'; readonly count: number}
	| {readonly kind: 'operation_failed'; readonly operation: 'record' | 'query' | 'transaction' | 'export' | 'verify' | 'prune'; readonly code: string; readonly reportable: boolean}
	| {readonly kind: 'integrity_failed'}
	| {readonly kind: 'pruned'; readonly count: number}
	| {readonly kind: 'finalization_failed'; readonly operation: 'flush' | 'shutdown'; readonly code: string}
	| {readonly kind: 'recovered'}

type Observer = (event: AuditTelemetryEvent) => void

const controllers = new WeakMap<object, {observer?: Observer}>()

export function registerAuditTelemetryTarget(audit: ManagedAudit): void {
	controllers.set(audit, {})
}

export function emitAuditTelemetry(audit: ManagedAudit, event: AuditTelemetryEvent): void {
	try { controllers.get(audit)?.observer?.(Object.freeze(event)) } catch { /* isolated */ }
}

export function attachAuditTelemetry(audit: ManagedAudit, observer: Observer): () => void {
	const controller = controllers.get(audit)
	if (!controller) throw new Error('Audit telemetry is unavailable for this runtime.')
	if (controller.observer) throw new Error('Audit observability is already attached.')
	controller.observer = observer
	let disposed = false
	return () => {
		if (disposed) return
		disposed = true
		if (controller.observer === observer) controller.observer = undefined
	}
}
