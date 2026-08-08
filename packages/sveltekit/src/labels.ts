import {normalizeClientRoute} from '@ooopsstudio/sdk/performance-browser'

import type {RouteContextLike, RouteResolverOptions} from './types'

const ROUTE_GROUP = /^\(.*\)$/
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i
const LABEL_KEY = /^[a-z_][a-z0-9_.-]{0,63}$/i
const DANGEROUS_LABEL_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_CUSTOM_LABELS = 32
const MAX_ROUTE_INPUT = 2_048

const safeNormalizeClientRoute = (route: string): string | undefined => {
	try { return normalizeClientRoute(route) } catch { return undefined }
}

const safeLabels = (labels?: Record<string, string>): Record<string, string> => {
	if (!labels || typeof labels !== 'object') return {}
	const copied: Record<string, string> = Object.create(null) as Record<string, string>
	try {
		for (const key of Reflect.ownKeys(labels).slice(0, MAX_CUSTOM_LABELS)) {
			if (typeof key !== 'string' || !LABEL_KEY.test(key) || DANGEROUS_LABEL_KEYS.has(key)) continue
			const descriptor = Object.getOwnPropertyDescriptor(labels, key)
			if (!descriptor?.enumerable || !('value' in descriptor)
				|| typeof descriptor.value !== 'string' || descriptor.value.length > 256) continue
			copied[key] = descriptor.value
		}
	} catch {
		return {}
	}
	return copied
}

const normalizeRouteSegment = (segment: string): string => {
	if (segment.startsWith('[[...') && segment.endsWith(']]')) {
		return ':rest'
	}
	if (segment.startsWith('[...') && segment.endsWith(']')) {
		return ':rest'
	}
	if (segment.startsWith('[[') && segment.endsWith(']]')) {
		return ':id'
	}
	if (segment.startsWith('[') && segment.endsWith(']')) {
		return ':id'
	}
	return segment
}

export const normalizeSvelteRouteId = (routeId?: string | null): string | undefined => {
	if (typeof routeId !== 'string' || !routeId || routeId.length > MAX_ROUTE_INPUT) {
		return undefined
	}
	const parts = routeId
		.split('/')
		.filter(Boolean)
		.filter((segment) => !ROUTE_GROUP.test(segment))
		.map(normalizeRouteSegment)

	return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

export const resolveSvelteRoute = (
	routeId?: string | null,
	url?: string,
	override?: string
): string => {
	const boundedOverride = typeof override === 'string' && override.length <= MAX_ROUTE_INPUT
		? override : undefined
	const boundedUrl = typeof url === 'string' && url.length <= MAX_ROUTE_INPUT ? url : undefined
	if (boundedOverride) {
		if (boundedOverride.includes('[') || boundedOverride.includes('(')) {
			const fromOverride = normalizeSvelteRouteId(boundedOverride)
			if (fromOverride) {
				return fromOverride
			}
		}
		if (ABSOLUTE_URL.test(boundedOverride)) {
			try {
				const normalized = safeNormalizeClientRoute(new URL(boundedOverride).pathname)
				if (normalized) return normalized
			} catch {
				// Invalid instrumentation overrides fall through to the application route.
			}
		} else {
			const normalized = safeNormalizeClientRoute(boundedOverride)
			if (normalized) return normalized
		}
	}
	const fromRoute = normalizeSvelteRouteId(routeId)
	if (fromRoute) {
		return fromRoute
	}
	if (boundedUrl && ABSOLUTE_URL.test(boundedUrl)) {
		try {
			const normalized = safeNormalizeClientRoute(new URL(boundedUrl).pathname)
			if (normalized) return normalized
		} catch {
			// Fall through to the bounded route normalizer.
		}
	}
	if (boundedUrl) {
		const fromUrl = safeNormalizeClientRoute(boundedUrl)
		if (fromUrl) {
			return fromUrl
		}
	}
	return safeNormalizeClientRoute(boundedUrl ?? '/') ?? '/'
}

export const mergeLabels = (
	base?: Record<string, string>,
	overrides?: Record<string, string>
): Record<string, string> => ({
	...safeLabels(base),
	...safeLabels(overrides)
})

export const resolveRouteFromValue = <TValue extends RouteContextLike>(
	value: TValue,
	options?: RouteResolverOptions<TValue>
): string => {
	let routeId: string | null | undefined
	let pathname: string | undefined
	try { routeId = value.route?.id } catch { /* route metadata is observational */ }
	try { pathname = value.url?.pathname } catch { /* route metadata is observational */ }
	return resolveSvelteRoute(routeId, pathname, resolveRouteOverride(value, options))
}

export const resolveRouteOverride = <TValue>(
	value: TValue,
	options?: Pick<RouteResolverOptions<TValue>, 'getRoute' | 'route'>
): string | undefined => {
	try {
		const resolved = options?.getRoute?.(value)
		if (typeof resolved === 'string') return resolved
	} catch {
		// Optional route readers are observational and fail open.
	}
	try { return typeof options?.route === 'string' ? options.route : undefined } catch { return undefined }
}

export const buildBrowserLabels = (
	kind: string,
	route: string | undefined,
	labels?: Record<string, string>
): Record<string, string> => ({
	...safeLabels(labels),
	runtime: 'browser',
	kind,
	...(route ? {route} : {})
})

export const buildServerLabels = (
	kind: string,
	route: string,
	labels?: Record<string, string>
): Record<string, string> => ({
	...safeLabels(labels),
	runtime: 'server',
	kind,
	route
})
