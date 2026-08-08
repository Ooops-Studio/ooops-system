import type {ManagedAudit} from '@ooopsstudio/core/ports/audit'

import {attachAuditTelemetry, type AuditTelemetryEvent} from '../runtime-capabilities'

export type AuditObservabilityEvent = AuditTelemetryEvent
export type AuditObservabilityAttachment = () => void
export type AuditObservabilityListener = (event: AuditObservabilityEvent) => void

const attachments = new WeakSet<ManagedAudit>()

/** Attach one fail-open listener without exposing audit runtime internals. */
export function attachAuditObservability(
	audit: ManagedAudit,
	listener: AuditObservabilityListener
): AuditObservabilityAttachment {
	if (typeof listener !== 'function') throw new TypeError('audit_invalid_observability')
	if (attachments.has(audit)) throw new Error('AUDIT_OBSERVABILITY_ATTACHED')
	const detachTelemetry = attachAuditTelemetry(audit, (event) => {
		try { listener(Object.freeze(event)) } catch { /* observability is fail-open */ }
	})
	attachments.add(audit)
	let active = true
	return () => {
		if (!active) return
		active = false
		attachments.delete(audit)
		detachTelemetry()
	}
}
