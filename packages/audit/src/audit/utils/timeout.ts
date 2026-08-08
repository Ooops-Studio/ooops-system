export async function withAuditTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Audit ${operation} timed out after ${timeoutMs}ms.`)), timeoutMs)
			})
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}
