import {ignorePromiseRejection} from './performance-port-method'

const PRIVATE_LABEL = /access|api.?key|auth|bear|cook|cred|id$|jwt|^key$|mail|oauth|pass|priv|secr|sess|token/i
export const isSafeTelemetryLabelKey = (key: string): boolean =>
	/^[a-z_][\w.-]{0,63}$/i.test(key) && !PRIVATE_LABEL.test(key)

type BrowserLocationLike = {
	href?: string
	origin?: string
	pathname?: string
}

type EventTargetWithAttributes = EventTarget & {
	tagName?: string
	currentSrc?: string
	getAttribute?: (name: string) => string | null
}

type BrowserEventListener = ((event: Event) => void) | {handleEvent(event: Event): void}

export type BrowserEventTarget = {
	addEventListener?: (
		type: string,
		listener: BrowserEventListener,
		options?: boolean | {capture?: boolean}
	) => void
	removeEventListener?: (
		type: string,
		listener: BrowserEventListener,
		options?: boolean | {capture?: boolean}
	) => void
}

export const readBrowserLocation = (key: keyof BrowserLocationLike): string | undefined => {
	try {
		const location: unknown = (globalThis as {location?: unknown}).location
		ignorePromiseRejection(location)
		const value: unknown = (location as BrowserLocationLike | undefined)?.[key]
		ignorePromiseRejection(value)
		return typeof value === 'string' ? value : undefined
	} catch { return undefined }
}

export const callBrowserMethod = (
	target: unknown,
	key: PropertyKey,
	args: unknown[]
): unknown => {
	ignorePromiseRejection(target)
	const method: unknown = (target as Record<PropertyKey, unknown>)[key]
	ignorePromiseRejection(method)
	const result: unknown = Reflect.apply(method as never, target, args)
	ignorePromiseRejection(result)
	return result
}
type PerformanceObserverInstance = {
	observe(options: {type?: string; entryTypes?: readonly string[]; buffered?: boolean}): void
	disconnect(): void
}

type PerformanceObserverConstructor = {
	new (
		callback: (list: {
			getEntries(): Array<{
				duration: number
				name?: string
			}>
		}) => void
	): PerformanceObserverInstance
	supportedEntryTypes?: readonly string[]
}

export const getPerformanceObserver = (): PerformanceObserverConstructor | null => {
	try {
		const Observer: unknown = globalThis.PerformanceObserver
		ignorePromiseRejection(Observer)
		return typeof Observer === 'function' ? Observer as PerformanceObserverConstructor : null
	} catch { return null }
}

export const supportsEntryType = (entryType: string): boolean => {
	try {
		const Observer = getPerformanceObserver()
		const supported: unknown = Observer?.supportedEntryTypes
		ignorePromiseRejection(supported)
		return Array.isArray(supported) && supported.includes(entryType)
	} catch {
		return false
	}
}

const pathOnly = (value: string): string => value.split(/[?#]/)[0]!
const RESOURCE_ID = /^(?:\d+|[a-f]{16,23}|[a-z0-9+_=-]{24,}|(?=.*\d)(?=.*[a-z]).+)$|@/i
export const isDynamicPathSegment = (value: string): boolean =>
	RESOURCE_ID.test(value) || PRIVATE_LABEL.test(value)

const isFontPath = (pathname: string): boolean =>
	/\.(woff2?|ttf|otf|eot)$/i.test(pathname)

const readResourceProperty = (target: EventTargetWithAttributes | null, key: 'tagName' | 'currentSrc'): unknown => {
	try {
		const result: unknown = target?.[key]
		ignorePromiseRejection(result)
		return result
	} catch { return undefined }
}

const readResourceAttribute = (target: EventTargetWithAttributes | null, name: string): string | null => {
	try {
		const result = callBrowserMethod(target, 'getAttribute', [name])
		return typeof result === 'string' ? result : null
	} catch { return null }
}

const sanitizeResourceUrl = (resourceUrl: string): string => {
	try {
		const base = readBrowserLocation('href') ?? 'http://localhost/'
		const currentOrigin = readBrowserLocation('origin') ?? new URL(base).origin
		const parsed = new URL(resourceUrl, base)
		return parsed.origin === currentOrigin ? 'same-origin' : 'external'
	} catch {
		return 'external'
	}
}

export const classifyResourceType = (target: EventTarget | null): string | null => {
	const resourceTarget = target as EventTargetWithAttributes | null
	const observedTagName = readResourceProperty(resourceTarget, 'tagName')
	if (typeof observedTagName !== 'string' || !observedTagName) return null
	const tagName = observedTagName.toUpperCase()
	if (tagName === 'SCRIPT') {
		return 'script'
	}
	if (tagName === 'IMG') {
		return 'image'
	}
	if (tagName === 'LINK') {
		const rel = (readResourceAttribute(resourceTarget, 'rel') ?? '').toLowerCase()
		const as = (readResourceAttribute(resourceTarget, 'as') ?? '').toLowerCase()
		const href = readResourceAttribute(resourceTarget, 'href') ?? ''
		if (rel.includes('stylesheet') || as === 'style' || href.toLowerCase().endsWith('.css')) {
			return 'style'
		}
		if (as === 'font' || isFontPath(pathOnly(href).toLowerCase())) {
			return 'font'
		}
		if (as === 'script') {
			return 'script'
		}
	}
	return 'other'
}

export const resolveResourceUrl = (target: EventTarget | null): string => {
	const resourceTarget = target as EventTargetWithAttributes | null
	const currentSrc = readResourceProperty(resourceTarget, 'currentSrc')
	const resource = typeof currentSrc === 'string' && currentSrc
		? currentSrc : readResourceAttribute(resourceTarget, 'src') || readResourceAttribute(resourceTarget, 'href')
	return resource ? sanitizeResourceUrl(resource) : 'external'
}
