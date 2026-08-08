import {execFileSync} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const args = parseArgs(process.argv.slice(2))
const isDryRun = args['dry-run'] === true
const monorepoConfig = await readMonorepoConfig()
const registry = validateRegistry(args.registry ?? process.env.REGISTRY_STRATEGY ?? monorepoConfig.registryStrategy ?? 'npm')
const hasNpmToken = Boolean(process.env.NPM_TOKEN)
const hasTrustedPublishingSignals = Boolean(
	process.env.GITHUB_ACTIONS === 'true'
	&& process.env.ACTIONS_ID_TOKEN_REQUEST_URL
	&& process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
	&& process.env.NPM_CONFIG_PROVENANCE === 'true'
	&& isAtLeastVersion(process.versions.node, '22.14.0')
	&& isAtLeastVersion(readNpmVersion(), '11.5.0')
)
const hasGitHubPackagesToken = Boolean(
	process.env.GITHUB_PACKAGES_TOKEN || process.env.GITHUB_TOKEN
)

const checks = {
	npm: [
		{
			ok: hasNpmToken || hasTrustedPublishingSignals,
			message: 'npm publishing needs either NPM_TOKEN or npm trusted publishing with GitHub OIDC, Node >=22.14, npm >=11.5, and provenance enabled.'
		}
	],
	github: [
		{
			ok: hasGitHubPackagesToken,
			message: 'GitHub Packages publishing needs GITHUB_PACKAGES_TOKEN or GITHUB_TOKEN.'
		}
	],
	both: [
		{
			ok: hasNpmToken || hasTrustedPublishingSignals,
			message: 'npm publishing needs either NPM_TOKEN or npm trusted publishing with GitHub OIDC, Node >=22.14, npm >=11.5, and provenance enabled.'
		},
		{
			ok: hasGitHubPackagesToken,
			message: 'GitHub Packages publishing needs GITHUB_PACKAGES_TOKEN or GITHUB_TOKEN.'
		}
	]
}[registry]

console.log(`Release preflight${isDryRun ? ' dry-run' : ''}:`)
console.log(`- registry strategy: ${registry}`)
console.log(`- NPM_TOKEN present: ${hasNpmToken ? 'yes' : 'no'}`)
console.log(`- trusted publishing signals present: ${hasTrustedPublishingSignals ? 'yes' : 'no'}`)
console.log(`- GitHub Packages token present: ${hasGitHubPackagesToken ? 'yes' : 'no'}`)

if (isDryRun) {
	console.log('- publish step will be skipped by the workflow dry-run path')
	process.exit(0)
}

const failures = checks.filter((check) => !check.ok)

if (failures.length > 0) {
	console.error('Release preflight failed.')

	for (const failure of failures) {
		console.error(`- ${failure.message}`)
	}

	process.exit(1)
}

console.log('Release preflight passed.')

function parseArgs(argv) {
	const parsed = {}

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]

		if (!argument.startsWith('--')) {
			throw new Error(`Unexpected argument "${argument}"`)
		}

		const [key, inlineValue] = argument.slice(2).split('=')

		if (inlineValue !== undefined) {
			parsed[key] = inlineValue
			continue
		}

		const nextValue = argv[index + 1]

		if (!nextValue || nextValue.startsWith('--')) {
			parsed[key] = true
			continue
		}

		parsed[key] = nextValue
		index += 1
	}

	return parsed
}

function validateRegistry(value) {
	if (!['npm', 'github', 'both'].includes(value)) {
		throw new Error('Registry strategy must be one of: npm, github, both.')
	}

	return value
}

async function readMonorepoConfig() {
	try {
		return JSON.parse(await readFile(path.join(process.cwd(), 'monorepo.config.json'), 'utf8'))
	} catch(error) {
		if (error?.code === 'ENOENT') return {}
		throw error
	}
}

function readNpmVersion() {
	try {
		return execFileSync('npm', ['--version'], {encoding: 'utf8'}).trim()
	} catch {
		return '0.0.0'
	}
}

function isAtLeastVersion(value, minimum) {
	const parse = (version) => version.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
	const current = parse(value)
	const required = parse(minimum)
	for (let index = 0; index < required.length; index += 1) {
		if (current[index] > required[index]) return true
		if (current[index] < required[index]) return false
	}
	return true
}
