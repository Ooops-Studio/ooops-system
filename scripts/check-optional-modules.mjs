import {access, readFile, readdir} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const modulesRoot = path.join(root, 'optional-modules')
const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const config = JSON.parse(await readFile(path.join(root, 'monorepo.config.json'), 'utf8'))
const entries = (await readdir(modulesRoot, {withFileTypes: true}))
	.filter((entry) => entry.isDirectory())
const modules = new Map()

for (const entry of entries) {
	const manifestPath = path.join(modulesRoot, entry.name, 'module.json')
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
	assert(manifest.id === entry.name, `${relative(manifestPath)} id must match directory name`)
	assert(!modules.has(manifest.id), `Duplicate optional module id "${manifest.id}"`)
	for (const field of ['label', 'description']) assertString(manifest[field], `${relative(manifestPath)} requires "${field}"`)
	for (const field of ['files', 'scripts', 'requires', 'conflicts', 'validationCommands', 'packageArchetypes']) {
		if (manifest[field] !== undefined) assert(Array.isArray(manifest[field]), `${relative(manifestPath)} "${field}" must be an array`)
	}
	for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'workflowPermissions']) {
		if (manifest[field] !== undefined) assertObject(manifest[field], `${relative(manifestPath)} "${field}" must be an object`)
	}
	modules.set(manifest.id, manifest)
}

for (const manifest of modules.values()) {
	for (const file of manifest.files ?? []) await access(path.join(root, resolveStarterPath(file)))
	for (const archetype of manifest.packageArchetypes ?? []) {
		await access(path.join(root, resolveStarterPath(archetype)))
	}
	for (const script of manifest.scripts ?? []) assert(rootManifest.scripts?.[script], `${manifest.id} references missing root script "${script}"`)
	for (const command of manifest.validationCommands ?? []) {
		const script = command.match(/^pnpm\s+(?:-w\s+)?([^\s]+)/)?.[1]
		if (script) assert(rootManifest.scripts?.[script], `${manifest.id} validation command references missing script "${script}"`)
	}
	for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
		for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
			assert(rootManifest[field]?.[dependency] === range, `${manifest.id} references missing or mismatched ${field.slice(0, -3)} "${dependency}"`)
		}
	}
	for (const dependency of [...(manifest.requires ?? []), ...(manifest.conflicts ?? [])]) assert(modules.has(dependency), `${manifest.id} references unknown module "${dependency}"`)
	for (const permission of Object.values(manifest.workflowPermissions ?? {})) assert(['none', 'read', 'write'].includes(permission), `${manifest.id} has invalid workflow permission`)
}

for (const id of config.enabledModules) assert(modules.has(id), `monorepo.config.json enables unknown module "${id}"`)
assert(['npm', 'github', 'both'].includes(config.registryStrategy), 'monorepo.config.json has an invalid registryStrategy')
assert(['public', 'restricted'].includes(config.packageAccess), 'monorepo.config.json has an invalid packageAccess')
assert(['trusted-publishing', 'npm-token'].includes(config.publishingMode), 'monorepo.config.json has an invalid publishingMode')
assert(['versions', 'sha'].includes(config.actionPinning), 'monorepo.config.json has an invalid actionPinning')
assert(['minimal-library', 'internal-packages', 'public-strict'].includes(config.preset), 'monorepo.config.json has an invalid preset')
assert(typeof config.starterPackageDir === 'string' && /^packages\/[A-Za-z0-9._-]+$/.test(config.starterPackageDir), 'monorepo.config.json has an invalid starterPackageDir')
assert(!(config.registryStrategy === 'both' && config.packageAccess === 'restricted'), 'Registry strategy "both" only supports public package access.')
assert(
	!(config.enabledModules.includes('registry-github') && config.registryStrategy === 'npm'),
	'registry-github requires registryStrategy "github" or "both".'
)
assert(
	(config.registryStrategy === 'npm' || config.enabledModules.includes('registry-github')),
	'registryStrategy "github" and "both" require the registry-github module.'
)

const enabled = new Set(config.enabledModules)
for (const id of enabled) {
	for (const required of modules.get(id).requires ?? []) assert(enabled.has(required), `${id} requires enabled module ${required}`)
	for (const conflict of modules.get(id).conflicts ?? []) assert(!enabled.has(conflict), `${id} conflicts with enabled module ${conflict}`)
}

console.log(`Validated ${modules.size} optional module manifests and monorepo policy consistency.`)

function assertObject(value, message) { assert(value && typeof value === 'object' && !Array.isArray(value), message) }
function assertString(value, message) { assert(typeof value === 'string' && value.trim(), message) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function relative(filePath) { return path.relative(root, filePath) }
function resolveStarterPath(value) { return value.replaceAll('{{starterPackageDir}}', config.starterPackageDir) }
