import {spawn} from 'node:child_process'
import {cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const args = parseArgs(process.argv.slice(2))
const [command = 'status', moduleId] = args._
const cacheRoot = path.join(root, '.optional-module-cache')
const index = await readCacheIndex()
const config = await readJson(path.join(root, 'monorepo.config.json'))
const modulesById = new Map(index.modules.map((module) => [module.id, module]))

assert(['list', 'status', 'add', 'remove'].includes(command), 'Usage: setup:module <list|status|add|remove> [module-id] [--registry npm|github|both] [--dry-run]')

if (command === 'list') {
	for (const module of index.modules) {
		console.log(`${module.id}\t${module.label}`)
	}
	process.exit(0)
}

const enabled = new Set(config.enabledModules ?? [])

if (command === 'status') {
	console.log(`Registry strategy: ${config.registryStrategy ?? 'npm'}`)
	console.log(`Enabled optional modules: ${[...enabled].sort().join(', ') || 'none'}`)
	console.log(`Disabled optional modules: ${index.modules.filter((module) => !enabled.has(module.id)).map((module) => module.id).join(', ') || 'none'}`)
	process.exit(0)
}

assert(moduleId, `setup:module ${command} requires a module id.`)
assert(modulesById.has(moduleId), `Unknown optional module "${moduleId}".`)

let nextEnabled
let nextRegistry = config.registryStrategy ?? 'npm'
if (command === 'add') {
	if (moduleId === 'registry-github') {
		assert(['github', 'both'].includes(args.registry), 'Adding registry-github requires --registry github or --registry both.')
		nextRegistry = args.registry
	} else {
		assert(!args.registry, '--registry is only valid when adding or removing registry-github.')
	}
	nextEnabled = addWithRequirements(enabled, moduleId)
	assertNoConflicts(nextEnabled)
	console.log(`Will enable: ${[...nextEnabled].filter((id) => !enabled.has(id)).sort().join(', ') || 'nothing'}`)
} else {
	if (moduleId === 'registry-github') {
		assert(args.registry === 'npm', 'Removing registry-github requires --registry npm to make the registry transition explicit.')
		nextRegistry = 'npm'
	} else {
		assert(!args.registry, '--registry is only valid when adding or removing registry-github.')
	}
	assertCanRemove(enabled, moduleId)
	nextEnabled = new Set(enabled)
	nextEnabled.delete(moduleId)
	console.log(`Will disable: ${moduleId}`)
}

if (args['dry-run']) {
	console.log('Dry run complete. No files were changed.')
	process.exit(0)
}

await assertRegistryTransition(nextRegistry)
const snapshot = await createSnapshot()
try {
	await restoreModuleManifests()
	for (const id of nextEnabled) {
		if (!enabled.has(id)) await restoreModuleFiles(id)
	}

	await runInitializer(nextEnabled, nextRegistry)
	console.log(`Optional module configuration updated: ${[...nextEnabled].sort().join(', ') || 'none'}.`)
} catch(error) {
	await restoreSnapshot(snapshot)
	throw error
} finally {
	await rm(snapshot.directory, {recursive: true, force: true})
}

function addWithRequirements(current, id) {
	const result = new Set(current)
	const visit = (candidate) => {
		if (result.has(candidate)) return
		result.add(candidate)
		for (const required of modulesById.get(candidate).requires ?? []) {
			assert(modulesById.has(required), `${candidate} requires unknown module "${required}".`)
			visit(required)
		}
	}
	visit(id)
	return result
}

function assertNoConflicts(candidateEnabled) {
	for (const id of candidateEnabled) {
		for (const conflict of modulesById.get(id).conflicts ?? []) {
			assert(!candidateEnabled.has(conflict), `${id} conflicts with ${conflict}.`)
		}
	}
}

function assertCanRemove(current, id) {
	const dependents = [...current].filter((candidate) =>
		(modulesById.get(candidate).requires ?? []).includes(id)
	)
	assert(dependents.length === 0, `Cannot remove ${id}; it is required by: ${dependents.join(', ')}.`)
}

async function restoreModuleManifests() {
	for (const module of index.modules) {
		const source = path.join(cacheRoot, 'modules', module.id)
		const destination = path.join(root, 'optional-modules', module.id)
		await rm(destination, {recursive: true, force: true})
		await mkdir(path.dirname(destination), {recursive: true})
		await cp(source, destination, {recursive: true})
		await writeFile(path.join(destination, 'module.json'), JSON.stringify(module, null, '\t') + '\n')
	}
}

async function restoreModuleFiles(id) {
	for (const entry of index.files.filter((file) => file.moduleId === id)) {
		const source = path.join(cacheRoot, entry.cachePath)
		const destination = path.join(root, resolveTemplatePath(entry.templatePath))
		await rm(destination, {recursive: true, force: true})
		await mkdir(path.dirname(destination), {recursive: true})
		await cp(source, destination, {recursive: true})
	}
}

async function runInitializer(nextEnabled, registry) {
	const rootManifest = await readJson(path.join(root, 'package.json'))
	const starterManifest = await readJson(path.join(root, config.starterPackageDir, 'package.json'))
	const [scope = '', packageName = 'package'] = String(starterManifest.name ?? '').replace(/^@/, '').split('/')
	assert(scope && packageName, 'The starter package must have a scoped package name.')
	const repo = parseRepository(rootManifest.repository?.url)
	assert(repo.owner && repo.name, 'Could not derive repository owner/name from package.json.')

	const initializerArgs = [
		'scripts/init-template.mjs',
		'--yes',
		'--scope', scope,
		'--repo-owner', repo.owner,
		'--repo-name', repo.name,
		'--workspace-name', rootManifest.name.replace(/^@[^/]+\//, ''),
		'--package-name', packageName,
		'--package-dir', path.basename(config.starterPackageDir),
		'--package-description', starterManifest.description ?? `${packageName} package.`,
		'--preset', config.preset ?? 'internal-packages',
		'--registry', registry,
		'--package-access', config.packageAccess ?? 'public',
		'--action-pinning', config.actionPinning ?? 'versions',
		'--publish-auth', config.publishingMode ?? 'trusted-publishing'
	]
	initializerArgs.push('--modules', nextEnabled.size > 0 ? [...nextEnabled].sort().join(',') : 'none')
	await run(process.execPath, initializerArgs, {cwd: root})
}

async function assertRegistryTransition(registry) {
	if (!['github', 'both'].includes(registry)) return
	const rootManifest = await readJson(path.join(root, 'package.json'))
	const starterManifest = await readJson(path.join(root, config.starterPackageDir, 'package.json'))
	const scope = String(starterManifest.name ?? '').match(/^@([^/]+)\//)?.[1]
	const owner = parseRepository(rootManifest.repository?.url).owner
	assert(scope && owner && scope.toLowerCase() === owner.toLowerCase(), 'GitHub Packages requires the starter package scope to match the GitHub repository owner or organization.')
}

async function createSnapshot() {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'setup-module-snapshot-'))
	const snapshotRoot = path.join(directory, 'workspace')
	await cp(root, snapshotRoot, {recursive: true, filter: (source) => !['.git', 'node_modules'].includes(path.basename(source))})
	return {directory, root: snapshotRoot}
}

async function restoreSnapshot(snapshot) {
	for (const entry of await readdir(root)) {
		if (entry === '.git' || entry === 'node_modules') continue
		await rm(path.join(root, entry), {recursive: true, force: true})
	}
	for (const entry of await readdir(snapshot.root)) {
		await cp(path.join(snapshot.root, entry), path.join(root, entry), {recursive: true})
	}
}
function resolveTemplatePath(templatePath) {
	return templatePath.replaceAll('{{starterPackageDir}}', config.starterPackageDir)
}

async function readCacheIndex() {
	try {
		return JSON.parse(await readFile(path.join(cacheRoot, 'index.json'), 'utf8'))
	} catch(error) {
		if (error?.code === 'ENOENT') {
			throw new Error('Optional module cache is missing. Run pnpm init:template once before using setup:module.')
		}
		throw error
	}
}

async function readJson(file) {
	return JSON.parse(await readFile(file, 'utf8'))
}

function parseRepository(value) {
	const match = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(value ?? '')
	return {owner: match?.[1] ?? '', name: match?.[2] ?? ''}
}

function parseArgs(argv) {
	const parsed = {_ : []}
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === '--dry-run') parsed['dry-run'] = true
		else if (argument === '--registry') {
			const value = argv[index + 1]
			assert(value && !value.startsWith('--'), '--registry requires npm, github, or both.')
			assert(['npm', 'github', 'both'].includes(value), '--registry must be npm, github, or both.')
			parsed.registry = value
			index += 1
		}
		else if (argument.startsWith('--')) throw new Error(`Unknown option ${argument}`)
		else parsed._.push(argument)
	}
	return parsed
}

function run(command, commandArgs, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {cwd: options.cwd, stdio: 'inherit', env: process.env})
		child.on('close', (code) => code === 0
			? resolve()
			: reject(new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${code}`)))
	})
}

function assert(condition, message) {
	if (!condition) throw new Error(message)
}
