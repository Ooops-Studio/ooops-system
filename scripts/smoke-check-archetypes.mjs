import {access, readFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const archetypesRoot = path.join(repoRoot, 'examples', 'package-archetypes')
const rootManifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const hasSizeLimit = Boolean(rootManifest.scripts?.size)
const hasPublishCompatibility = Boolean(rootManifest.scripts?.publint && rootManifest.scripts?.attw)

const archetypes = [
	{
		name: 'public-package',
		requiredScripts: optionalScripts(['typecheck', 'build', 'test']),
		requiredFiles: optionalFiles(['package.json', 'README.md', 'tsconfig.json'], ['.size-limit.json']),
		validate(pkg) {
			assert(pkg.private !== true, 'should be publishable by default')
			assert(pkg.exports && pkg.files?.includes('dist'), 'should expose dist through exports/files')
		}
	},
	{
		name: 'private-workspace',
		requiredScripts: ['typecheck', 'build'],
		requiredFiles: ['package.json', 'README.md', 'tsconfig.json'],
		validate(pkg) {
			assert(pkg.private === true, 'should be marked private')
		}
	},
	{
		name: 'multi-entry-package',
		requiredScripts: optionalScripts(['typecheck', 'build', 'test']),
		requiredFiles: optionalFiles(['package.json', 'README.md', 'tsconfig.json', 'tsup.config.ts', 'vitest.config.ts'], ['.size-limit.mjs']),
		validate(pkg) {
			assert(Object.keys(pkg.exports ?? {}).length > 1, 'should demonstrate multiple public subpath exports')
		}
	},
	{
		name: 'adapter-package',
		requiredScripts: optionalScripts(['typecheck', 'build', 'test']),
		requiredFiles: optionalFiles(['package.json', 'README.md', 'tsconfig.json', 'tsup.config.ts', 'vitest.config.ts'], ['.size-limit.mjs']),
		validate(pkg) {
			assert(Object.keys(pkg.peerDependencies ?? {}).length > 0, 'should demonstrate peer dependencies')
		}
	}
]

for (const archetype of archetypes) {
	const archetypeDir = path.join(archetypesRoot, archetype.name)
	const manifestPath = path.join(archetypeDir, 'package.json')
	const pkg = JSON.parse(await readFile(manifestPath, 'utf8'))

	for (const script of archetype.requiredScripts) {
		assert(pkg.scripts?.[script], `${archetype.name} is missing the "${script}" script`)
	}

	for (const relativePath of archetype.requiredFiles) {
		await access(path.join(archetypeDir, relativePath))
	}

	archetype.validate(pkg)
}

console.log(`Validated ${archetypes.length} package archetype examples.`)

function optionalScripts(required) {
	const scripts = [...required]

	if (hasSizeLimit) {
		scripts.push('size')
	}

	if (hasPublishCompatibility) {
		scripts.push('publint', 'attw')
	}

	return scripts
}

function optionalFiles(required, sizeFiles) {
	return hasSizeLimit ? [...required, ...sizeFiles] : required
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message)
	}
}
