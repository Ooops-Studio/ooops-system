export function sanitizeUrlForDiagnostics(url: string): string {
	try {
		const parsed = new URL(url)
		// Paths may contain signed webhook credentials or tenant identifiers. The
		// origin is enough to identify the failing transport without retaining
		// caller-controlled endpoint material in diagnostics.
		return parsed.origin
	} catch {
		return '[invalid-url]'
	}
}
