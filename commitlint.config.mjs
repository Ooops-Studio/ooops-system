export default /** @type {import('@commitlint/types').UserConfig} */ ({
	extends: ['@commitlint/config-conventional'],

	// Let Changesets do its “Version Packages” thing without commit cops
	ignores: [
		(msg) => /^Version Packages/i.test(msg),
		// Optional: ignore your manual release bumps too
		(msg) => /^chore\(release\):/i.test(msg)
	],

	rules: {
		// add project-specific rules here if you must
	}
})