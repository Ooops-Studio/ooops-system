import {readFile, readdir} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const packagesRoot = path.join(repoRoot, 'packages')
const packageDirs = await readdir(packagesRoot, {withFileTypes: true})
const config = JSON.parse(await readFile(path.join(repoRoot, 'monorepo.config.json'), 'utf8'))

for (const entry of packageDirs) {
	if (!entry.isDirectory()) {
		continue
	}

	const manifestPath = path.join(packagesRoot, entry.name, 'package.json')
	const pkg = JSON.parse(await readFile(manifestPath, 'utf8'))

	assertNonEmptyString(pkg.name, manifestPath, '"name" is required')
	assertNonEmptyString(pkg.version, manifestPath, '"version" is required')
	assert(pkg.type === 'module', `${relative(manifestPath)} must set "type": "module"`)
	assertNonEmptyString(pkg.license, manifestPath, '"license" is required')
	assertNonEmptyString(pkg.description, manifestPath, '"description" is required')
	assertNonEmptyString(pkg.engines?.node, manifestPath, '"engines.node" is required')

	if (pkg.private === true) {
		continue
	}

	assertRepository(pkg, manifestPath)
	assertUrlLike(pkg.homepage, manifestPath, '"homepage" is required for publishable packages')
	assertUrlLike(pkg.bugs?.url, manifestPath, '"bugs.url" is required for publishable packages')
	assert(Array.isArray(pkg.files) && pkg.files.length > 0, `${relative(manifestPath)} must declare a non-empty "files" array`)
	assert(pkg.files.includes('dist'), `${relative(manifestPath)} must include "dist" in "files"`)
	assert(pkg.exports && Object.keys(pkg.exports).length > 0, `${relative(manifestPath)} must declare a non-empty "exports" map`)

	if (pkg.name.startsWith('@')) {
		assert(
			pkg.publishConfig?.access === config.packageAccess,
			`${relative(manifestPath)} must set "publishConfig.access" to "${config.packageAccess}"`
		)
	}
}

console.log('Validated package manifests for publishable and private workspace packages.')

function assertRepository(pkg, manifestPath) {
	const repository = pkg.repository
	assert(repository && typeof repository === 'object', `${relative(manifestPath)} must declare a "repository" object`)
	assert(repository.type === 'git', `${relative(manifestPath)} must set "repository.type" to "git"`)
	assertNonEmptyString(repository.url, manifestPath, '"repository.url" is required for publishable packages')
}

function assertUrlLike(value, manifestPath, message) {
	assertNonEmptyString(value, manifestPath, message)
	assert(/^https?:\/\//.test(value), `${relative(manifestPath)} ${message.replace(' is required for publishable packages', '')} must be an http(s) URL`)
}

function assertNonEmptyString(value, manifestPath, message) {
	assert(typeof value === 'string' && value.trim().length > 0, `${relative(manifestPath)} ${message}`)
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message)
	}
}

function relative(filePath) {
	return path.relative(repoRoot, filePath)
}
