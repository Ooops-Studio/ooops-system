import {access, cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const options = parseArgs(process.argv.slice(2))
const from = path.resolve(required(options.from, '--from is required'))
const sourceManifestPath = path.join(from, 'package.json')
const sourcePackage = JSON.parse(await readFile(sourceManifestPath, 'utf8'))
const packageName = options.name ?? sourcePackage.name
const targetDir = path.resolve(options.to ?? path.join(repoRoot, 'packages', unscopedName(packageName)))
const dryRun = options['dry-run'] === true
const force = options.force === true
const allowExternalTarget = options['allow-external-target'] === true

assertTargetDirectory(targetDir, allowExternalTarget, force)
assertNoPathOverlap(from, targetDir)

if (dryRun) {
	console.log(`[dry-run] copy package ${packageName}`)
	console.log(`[dry-run] from: ${from}`)
	console.log(`[dry-run] to: ${targetDir}`)
	console.log('[dry-run] workspace:, file:, and link: dependency ranges would be rewritten to ^0.0.0 and reported for review.')
	process.exit(0)
}

if (await exists(targetDir)) {
	if (!force) {
		throw new Error(`Target ${path.relative(repoRoot, targetDir)} already exists. Pass --force to replace it.`)
	}
	await rm(targetDir, {recursive: true, force: true})
}

await mkdir(path.dirname(targetDir), {recursive: true})
await cp(from, targetDir, {
	recursive: true,
	filter: (source) => !ignoredPath(source)
})

const warnings = await normalizeCopiedPackage(path.join(targetDir, 'package.json'), packageName)

console.log(`Copied ${packageName} to ${path.relative(repoRoot, targetDir)}.`)

if (warnings.length > 0) {
	console.log('Manual follow-up items:')
	for (const warning of warnings) {
		console.log(`- ${warning}`)
	}
}

console.log('Next steps:')
console.log('- Run pnpm install.')
console.log('- Review package metadata, internal dependency versions, and README links.')
console.log('- Run pnpm -w check:manifests and pnpm -w validate:ci.')

async function normalizeCopiedPackage(manifestPath, name) {
	const rootPkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
	const pkg = JSON.parse(await readFile(manifestPath, 'utf8'))
	const warnings = []
	const repositoryUrl = rootPkg.repository?.url ?? pkg.repository?.url
	const homepage = repositoryUrl?.replace(/^git\+/u, '').replace(/\.git$/u, '')

	pkg.name = name
	pkg.type ??= 'module'
	pkg.license ??= rootPkg.license ?? 'MIT'
	pkg.engines ??= {node: rootPkg.engines?.node ?? '>=20'}

	for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
		const deps = pkg[field]
		if (!deps) {
			continue
		}

		for (const [dependencyName, version] of Object.entries(deps)) {
			if (/^(?:workspace:|file:|link:)/u.test(version)) {
				deps[dependencyName] = '^0.0.0'
				warnings.push(`${field}.${dependencyName} was "${version}" and was rewritten to "^0.0.0"`)
			}
		}
	}

	if (pkg.private !== true && repositoryUrl && homepage) {
		pkg.repository = {type: 'git', url: repositoryUrl}
		pkg.homepage = homepage
		pkg.bugs = {url: `${homepage}/issues`}
	}

	validateCopiedPackageContract(pkg)
	await writeFile(manifestPath, `${JSON.stringify(pkg, null, '\t')}\n`)

	return warnings
}

function validateCopiedPackageContract(pkg) {
	const missing = []

	for (const script of ['typecheck', 'build']) {
		if (!pkg.scripts?.[script]) {
			missing.push(`script "${script}"`)
		}
	}

	if (pkg.private !== true) {
		if (!pkg.exports) {
			missing.push('"exports"')
		}

		if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
			missing.push('"files"')
		}
	}

	if (missing.length > 0) {
		throw new Error(`Copied package is missing required contract fields: ${missing.join(', ')}`)
	}
}

function parseArgs(args) {
	const parsed = {}

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]

		if (!arg.startsWith('--')) {
			continue
		}

		const [key, inlineValue] = arg.slice(2).split('=')
		parsed[key] = inlineValue ?? (args[index + 1]?.startsWith('--') ? true : args[++index] ?? true)
	}

	return parsed
}

function required(value, message) {
	if (!value) {
		throw new Error(message)
	}

	return value
}

function unscopedName(name) {
	return name.split('/').at(-1)
}

function assertTargetDirectory(target, allowExternal, force) {
	const packagesRoot = path.resolve(repoRoot, 'packages')
	const relativeTarget = path.relative(packagesRoot, target)
	const isWithinPackages = relativeTarget && !relativeTarget.startsWith(`..${path.sep}`) && relativeTarget !== '..' && !path.isAbsolute(relativeTarget)

	assert(
		isWithinPackages || (allowExternal && force),
		'--to must be inside packages/. Use --allow-external-target together with --force only when an external target is intentional.'
	)
}

function assertNoPathOverlap(source, target) {
	const sourceContainsTarget = isSameOrChild(source, target)
	const targetContainsSource = isSameOrChild(target, source)
	assert(
		!sourceContainsTarget && !targetContainsSource,
		'--from and --to must not be the same directory or contain one another.'
	)
}

function isSameOrChild(parent, candidate) {
	const relativePath = path.relative(parent, candidate)
	return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
}

function ignoredPath(filePath) {
	return /(?:^|\/)(?:node_modules|dist|coverage|\.turbo|\.cache|\.changeset)(?:\/|$)/u.test(filePath)
}

async function exists(target) {
	try {
		await access(target)
		return true
	} catch {
		return false
	}
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message)
	}
}
