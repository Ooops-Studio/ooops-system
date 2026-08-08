export interface ParsedSentryDsn {
	readonly envelopeDsn: string
	readonly endpoint: string
	readonly publicKey: string
	readonly secretKey?: string
}

const invalidDsn = (): Error => new Error('createSentryErrorSink: invalid Sentry DSN')
const MAX_SENTRY_DSN_LENGTH = 4_096

export function parseSentryDsn(dsn: string): ParsedSentryDsn {
	if (typeof dsn !== 'string' || dsn.length === 0 || dsn.length > MAX_SENTRY_DSN_LENGTH) throw invalidDsn()
	let url: URL
	try {
		url = new URL(dsn)
	} catch {
		throw invalidDsn()
	}
	if (url.protocol !== 'https:') throw invalidDsn()
	if (url.search || url.hash) throw invalidDsn()

	let publicKey: string
	let secretKey: string | undefined
	try {
		publicKey = decodeURIComponent(url.username)
		secretKey = url.password ? decodeURIComponent(url.password) : undefined
	} catch {
		throw invalidDsn()
	}
	const pathSegments = url.pathname.split('/').filter(Boolean)
	const encodedProjectId = pathSegments.pop()
	let projectId: string | undefined
	try { projectId = encodedProjectId ? decodeURIComponent(encodedProjectId) : undefined } catch { throw invalidDsn() }
	if (!publicKey || !projectId) throw invalidDsn()
	if (!/^[A-Za-z0-9_-]{1,256}$/u.test(publicKey)
		|| (secretKey !== undefined && !/^[A-Za-z0-9_-]{1,256}$/u.test(secretKey))
		|| !/^[A-Za-z0-9_-]{1,128}$/u.test(projectId)) throw invalidDsn()
	const pathPrefix = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : ''
	const safeProjectId = encodeURIComponent(projectId)
	const projectPath = `${pathPrefix}/${safeProjectId}`
	return {
		envelopeDsn: `${url.protocol}//${encodeURIComponent(publicKey)}@${url.host}${projectPath}`,
		endpoint: `${url.protocol}//${url.host}${pathPrefix}/api/${safeProjectId}/envelope/`,
		publicKey,
		...(secretKey ? {secretKey} : {})
	}
}
