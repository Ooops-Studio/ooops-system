import {spawn} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'

const args = parseArgs(process.argv.slice(2))
const repoRoot = process.cwd()
const monorepoConfig = await readMonorepoConfig()
const strategy = validateStrategy(args.registry ?? process.env.REGISTRY_STRATEGY ?? monorepoConfig.registryStrategy ?? 'npm')
const isDryRun = args['dry-run'] === true
const rootManifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const packageScope = (args.scope ?? process.env.GITHUB_PACKAGE_SCOPE ?? parseScope(rootManifest.name)).replace(/^@/, '')
const repositoryOwner = parseRepositoryOwner(rootManifest.repository?.url)

const targets = {
	npm: [
		{
			id: 'npm',
			registry: 'https://registry.npmjs.org',
			env: {
				NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
				NPM_CONFIG_PROVENANCE: process.env.NPM_CONFIG_PROVENANCE ?? 'true'
			}
		}
	],
	github: [
		{
			id: 'github',
			registry: 'https://npm.pkg.github.com',
			github: true,
			env: {
				NPM_CONFIG_PROVENANCE: 'false'
			}
		}
	],
	both: [
		{
			id: 'npm',
			registry: 'https://registry.npmjs.org',
			env: {
				NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
				NPM_CONFIG_PROVENANCE: process.env.NPM_CONFIG_PROVENANCE ?? 'true'
			}
		},
		{
			id: 'github',
			registry: 'https://npm.pkg.github.com',
			github: true,
			env: {
				NPM_CONFIG_PROVENANCE: 'false'
			}
		}
	]
}[strategy]

console.log(`Publishing strategy: ${strategy}`)

for (const target of targets) {
	console.log(`- ${target.id}: ${target.registry}`)
}

if (isDryRun) {
	console.log('Dry run complete. No packages were published.')
	process.exit(0)
}

for (const target of targets) {
	const cleanup = []
	const env = {...process.env, ...target.env}

	if (target.github) {
		assert(packageScope, 'GitHub Packages publishing requires a package scope. Pass --scope or use a scoped root package name.')
		assert(
			repositoryOwner && packageScope.toLowerCase() === repositoryOwner.toLowerCase(),
			'GitHub Packages publishing requires the package scope to match the GitHub repository owner or organization.'
		)
		const token = process.env.GITHUB_PACKAGES_TOKEN || process.env.GITHUB_TOKEN
		assert(token, 'GitHub Packages publishing requires GITHUB_PACKAGES_TOKEN or GITHUB_TOKEN.')
		const userConfigDir = await mkdtemp(path.join(tmpdir(), 'ooops-npmrc-'))
		const userConfigPath = path.join(userConfigDir, '.npmrc')
		await writeFile(userConfigPath, [
			`@${packageScope}:registry=https://npm.pkg.github.com`,
			`//npm.pkg.github.com/:_authToken=${token}`,
			'always-auth=true',
			''
		].join('\n'))
		env.NPM_CONFIG_USERCONFIG = userConfigPath
		cleanup.push(userConfigDir)
	}

	try {
		console.log(`Publishing to ${target.id}...`)
		await run('pnpm', ['-w', 'changeset', 'publish'], {env})
	} finally {
		for (const directory of cleanup) {
			await rm(directory, {recursive: true, force: true})
		}
	}
}

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

function validateStrategy(value) {
	assert(['npm', 'github', 'both'].includes(value), 'Registry strategy must be one of: npm, github, both.')
	return value
}

function parseScope(packageName) {
	const match = /^@([^/]+)\//.exec(packageName ?? '')
	return match?.[1] ?? ''
}

function parseRepositoryOwner(value) {
	const match = /github\.com[/:]([^/]+)\/[^/.]+(?:\.git)?$/u.exec(value ?? '')
	return match?.[1] ?? ''
}

async function readMonorepoConfig() {
	try {
		return JSON.parse(await readFile(path.join(repoRoot, 'monorepo.config.json'), 'utf8'))
	} catch(error) {
		if (error?.code === 'ENOENT') return {}
		throw error
	}
}

function run(command, commandArgs, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {
			cwd: repoRoot,
			stdio: 'inherit',
			env: options.env
		})

		child.on('close', (code) => {
			if (code === 0) {
				resolve()
				return
			}

			reject(new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${code}`))
		})
	})
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message)
	}
}
