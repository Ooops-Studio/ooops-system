// packages/demo/src/index.ts
/**
 * @file Demo package for monorepo template
 * Simple greeting function to demonstrate the template structure
 */

/**
 * Returns a friendly greeting message
 * @param name - The name to greet
 * @returns A greeting string
 * @example
 * greet('World') // "Hello, World"
 */
export function greet(name: string): string {
	return `Hello, ${name}`
}