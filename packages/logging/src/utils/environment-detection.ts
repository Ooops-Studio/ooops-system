/**
 * @file Environment detection utilities for server vs client runtime.
 * Uses runtime detection to determine if code is running on server or client.
 */

import {detectRuntime, type RuntimeType} from '@ooopsstudio/core/runtime'

/**
 * Environment type: server or client
 */
export type EnvironmentType = 'server' | 'client'

/**
 * Detect if current runtime is server (Node.js) or client (browser)
 * @returns Environment type
 */
export function detectEnvironment(): EnvironmentType {
	const runtime = detectRuntime()
	return isServerRuntime(runtime) ? 'server' : 'client'
}

/**
 * Check if a runtime type is server-side
 * @param runtime - Runtime type to check
 * @returns True if server-side
 */
function isServerRuntime(runtime: RuntimeType): boolean {
	return runtime.startsWith('node:') || runtime === 'deno'
}

/**
 * Check if current runtime is server (Node.js/Deno)
 * @returns True if running on server
 */
export function isServer(): boolean {
	return isServerRuntime(detectRuntime())
}

/**
 * Check if current runtime is client (browser)
 * @returns True if running in browser
 */
export function isClient(): boolean {
	return !isServer()
}
