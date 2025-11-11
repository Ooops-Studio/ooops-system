// packages/demo/test/index.test.ts
import {describe, it, expect} from 'vitest'

import {greet} from '../src/index'

describe('greet', () => {
	it('should return a greeting message', () => {
		expect(greet('World')).toBe('Hello, World')
		expect(greet('Alice')).toBe('Hello, Alice')
	})
})