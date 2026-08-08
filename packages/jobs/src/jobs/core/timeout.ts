export async function withJobsTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs)
			})
		])
	} finally { if (timer) clearTimeout(timer) }
}
