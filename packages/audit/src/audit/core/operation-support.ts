import {sanitizeAuditDiagnosticMessage} from '../utils/redaction'
export {withAuditTimeout} from '../utils/timeout'

export function redactedErrorMessage(error: unknown): string {
	return sanitizeAuditDiagnosticMessage(error)
}
