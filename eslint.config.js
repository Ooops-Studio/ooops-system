// Flat config
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import pluginImport from 'eslint-plugin-import'
import globals from 'globals'

// Flat config aligning with workspace standards (tabs, single quotes, no semicolons, max-len 100).

export default [
	js.configs.recommended,
	{ignores: ['**/dist/**', '**/coverage/**', '**/*.d.ts']},
	{
		files: ['**/*.{ts,tsx,js,mjs,cjs}'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {ecmaVersion: 2022, sourceType: 'module'},
			globals: {...globals.node}
		},
		plugins: {import: pluginImport, '@typescript-eslint': tseslint, '@stylistic': stylistic},
		settings: {
			'import/resolver': {
				typescript: {
					project: ['tsconfig.base.json'],
					alwaysTryTypes: true
				},
				node: {extensions: ['.js', '.ts', '.mjs', '.cjs']}
			},
			'import/extensions': ['.js', '.ts', '.mjs', '.cjs']
		},
		rules: {
			// Style (via stylistic)
			'@stylistic/array-bracket-spacing': ['error', 'never'],
			'@stylistic/arrow-parens': ['error', 'always'],
			'@stylistic/arrow-spacing': 'error',
			'@stylistic/comma-dangle': ['error', 'never'],
			'@stylistic/comma-spacing': ['error', {before: false, after: true}],
			'@stylistic/keyword-spacing': ['error', {before: true, after: true}],
			'@stylistic/linebreak-style': ['error', 'unix'],
			'@stylistic/max-len': ['error', {
				code: 100,
				tabWidth: 2,
				ignoreTrailingComments: true,
				ignoreUrls: true,
				ignoreStrings: true,
				ignoreTemplateLiterals: true,
				ignoreRegExpLiterals: true
			}],
			'@stylistic/no-multiple-empty-lines': ['error', {max: 1, maxEOF: 0}],
			'@stylistic/no-trailing-spaces': 'error',
			'@stylistic/object-curly-spacing': ['error', 'never'],
			'@stylistic/quotes': ['error', 'single', {avoidEscape: true}],
			'@stylistic/semi': ['error', 'never'],
			'@stylistic/space-before-function-paren': ['error', 'never'],
			'@stylistic/space-in-parens': ['error', 'never'],
			'@stylistic/space-infix-ops': ['error', {ignoreTypes: true}],
			'@stylistic/indent': ['error', 'tab'],

			// TS rules
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': ['warn', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
			'@typescript-eslint/no-explicit-any': 'error',

			// Don’t import other packages’ internals or test helpers
			'no-restricted-imports': ['error', {
				patterns: [
					{group: ['@*/**/src/**'], message: 'Do not import package internals. Use published exports only.'},
					{group: ['@*/**/(test|__tests__|testing)/**'], message: 'Testing helpers are not allowed in runtime code.'}
				]}
			],
			// Import hygiene
			'import/order': ['error', {
				groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
				alphabetize: {order: 'asc', caseInsensitive: true},
				'newlines-between': 'always'
			}]
		}
	}
]