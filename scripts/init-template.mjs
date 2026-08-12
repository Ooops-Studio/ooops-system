import {spawn} from 'node:child_process'
import {access, cp, mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {createInterface} from 'node:readline/promises'

import {applyActionPinning} from './action-references.mjs'

const args = parseArgs(process.argv.slice(2))

if (args.help) {
	printHelp()
	process.exit(0)
}

const repoRoot = process.cwd()
const packagesRoot = path.join(repoRoot, 'packages')
const optionalModules = await readOptionalModules(repoRoot)
const optionalModuleIds = optionalModules.map((module) => module.id)
const defaultOptionalModuleIds = optionalModuleIds.filter((moduleId) => !['registry-github', 'organization-policy'].includes(moduleId))
const presets = {
	'minimal-library': [],
	'internal-packages': defaultOptionalModuleIds,
	'public-strict': defaultOptionalModuleIds
}
const starterPackageDir = await resolveStarterPackageDir(packagesRoot)
const starterPackageName = path.basename(starterPackageDir)

const rootManifestPath = path.join(repoRoot, 'package.json')
const starterManifestPath = path.join(starterPackageDir, 'package.json')
const changesetConfigPath = path.join(repoRoot, '.changeset', 'config.json')
const rootReadmePath = path.join(repoRoot, 'README.md')
const starterReadmePath = path.join(starterPackageDir, 'README.md')
const monorepoConfigPath = path.join(repoRoot, 'monorepo.config.json')

const rootManifest = await readJson(rootManifestPath)
const starterManifest = await readJson(starterManifestPath)
const changesetConfig = await readJsonOrFallback(changesetConfigPath, {})
const rootReadme = await readFile(rootReadmePath, 'utf8')
const starterReadme = await readFile(starterReadmePath, 'utf8')

const gitRepoInfo = await readGitRepositoryInfo(repoRoot)
const repoInfo = parseRepositoryUrl(rootManifest.repository?.url ?? '')
const rootNameInfo = parseScopedName(rootManifest.name)
const starterNameInfo = parseScopedName(starterManifest.name)
const defaultScope = sanitizeScope(starterNameInfo.scope || rootNameInfo.scope || gitRepoInfo.owner || '')
const defaultRepoOwner = preferTemplateSafeValue(gitRepoInfo.owner, repoInfo.owner, 'ooops-studio')
const defaultRepoName = preferTemplateSafeValue(gitRepoInfo.repo, path.basename(repoRoot), 'repo-name')
const rl = shouldPrompt(args)
	? createInterface({input: process.stdin, output: process.stdout})
	: null

try {
	const scope = await resolveValue(
		'scope',
		args.scope,
		defaultScope
	)
	const repoOwner = await resolveValue('repo-owner', args['repo-owner'], defaultRepoOwner)
	const repoName = await resolveValue('repo-name', args['repo-name'], defaultRepoName)
	const workspaceName = await resolveValue('workspace-name', args['workspace-name'], rootNameInfo.name || repoName)
	const packageName = await resolveValue('package-name', args['package-name'], starterNameInfo.name || workspaceName)
	const packageDir = await resolveValue('package-dir', args['package-dir'], packageName)
	const packageDescription = await resolveValue(
		'package-description',
		args['package-description'],
		defaultPackageDescription(starterManifest.description, packageName, repoName)
	)

	validateScope(scope)
	validatePackageSegment(workspaceName, 'workspace-name')
	validatePackageSegment(packageName, 'package-name')
	validatePackageDir(packageDir)
	validateRepositorySegment(repoOwner, 'repo-owner')
	validateRepositorySegment(repoName, 'repo-name')
	validateDescription(packageDescription)

	const values = {
		scope,
		repoOwner,
		repoName,
		workspaceName,
		packageName,
		packageDir,
		packageDescription
	}
	const moduleOptions = await resolveModuleOptions(args, rl, optionalModules, {scope, repoOwner})

	if (!args.dryRun && !args.yes && rl) {
		printSummary(values, starterPackageName, moduleOptions)
		const confirmation = (await rl.question('Proceed with template initialization? [y/N] ')).trim().toLowerCase()

		if (!['y', 'yes'].includes(confirmation)) {
			console.log('Aborted.')
			process.exit(1)
		}
	}

	const changedPaths = []
	const nextStarterPackageDir = path.join(packagesRoot, packageDir)

	let nextRootManifest = {
		...rootManifest,
		name: scopedName(scope, workspaceName),
		repository: {
			...(rootManifest.repository ?? {}),
			type: 'git',
			url: `https://github.com/${repoOwner}/${repoName}.git`
		}
	}
	nextRootManifest = configureRootManifest(nextRootManifest, moduleOptions, optionalModules)

	await writeJson(rootManifestPath, nextRootManifest, args.dryRun, changedPaths)
	await writeJson(monorepoConfigPath, {
		$schema: './schemas/monorepo-config.schema.json',
		registryStrategy: moduleOptions.registry,
		packageAccess: moduleOptions.packageAccess,
		publishingMode: moduleOptions.publishingMode,
		actionPinning: moduleOptions.actionPinning,
		preset: moduleOptions.preset,
		enabledModules: [...moduleOptions.enabled].sort(),
		starterPackageDir: `packages/${packageDir}`
	}, args.dryRun, changedPaths)

	const nextStarterManifest = configurePackageManifest({
		...starterManifest,
		name: scopedName(scope, packageName),
		description: packageDescription,
		repository: {
			...(starterManifest.repository ?? {}),
			type: 'git',
			url: `git+https://github.com/${repoOwner}/${repoName}.git`
		},
		homepage: `https://github.com/${repoOwner}/${repoName}`,
		bugs: {
			...(starterManifest.bugs ?? {}),
			url: `https://github.com/${repoOwner}/${repoName}/issues`
		}
	}, moduleOptions)

	await writeJson(starterManifestPath, nextStarterManifest, args.dryRun, changedPaths)

	if (moduleOptions.enabled.has('release')) {
		const nextChangesetConfig = {
			...changesetConfig,
			changelog: ['@changesets/changelog-github', {repo: `${repoOwner}/${repoName}`}]
		}

		await writeJson(changesetConfigPath, nextChangesetConfig, args.dryRun, changedPaths)
	}

	const exampleUpdates = [
		['examples/package-archetypes/public-package/package.json', scopedName(scope, packageName)],
		['examples/package-archetypes/private-workspace/package.json', scopedName(scope, `${packageName}-internal`)],
		['examples/package-archetypes/multi-entry-package/package.json', scopedName(scope, `${packageName}-multi`)],
		['examples/package-archetypes/adapter-package/package.json', scopedName(scope, `${packageName}-adapter`)]
	]

	for (const [relativePath, exampleName] of exampleUpdates) {
		const absolutePath = path.join(repoRoot, relativePath)
		const exampleManifest = await readJson(absolutePath)
		await writeJson(
			absolutePath,
			configurePackageManifest({...exampleManifest, name: exampleName}, moduleOptions),
			args.dryRun,
			changedPaths
		)
	}

	for (const module of optionalModules) {
		const manifestPath = path.join(repoRoot, 'optional-modules', module.id, 'module.json')
		const source = await readFile(manifestPath, 'utf8')
		const updated = source.replaceAll(`packages/${starterPackageName}/`, `packages/${packageDir}/`)
		if (updated !== source) await writeText(manifestPath, updated, args.dryRun, changedPaths)
	}

	await writeText(
		path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
		createCiWorkflow(moduleOptions),
		args.dryRun,
		changedPaths
	)

	if (moduleOptions.enabled.has('release')) {
		await writeText(
			path.join(repoRoot, '.github', 'workflows', 'release.yml'),
			createReleaseWorkflow(moduleOptions),
			args.dryRun,
			changedPaths
		)
	}

	await writeText(
		starterReadmePath,
		starterReadme
			.replaceAll(starterManifest.name, scopedName(scope, packageName))
			.replaceAll(`packages/${starterPackageName}/`, `packages/${packageDir}/`),
		args.dryRun,
		changedPaths
	)

	await writeText(
		rootReadmePath,
		rewriteReadmeForModules(rootReadme
			.replaceAll(`packages/${starterPackageName}/`, `packages/${packageDir}/`)
			.replace(`└─ ${starterPackageName}/                         # simple public single-entry package example`, `└─ ${packageDir}/                         # simple public single-entry package example`),
		moduleOptions),
		args.dryRun,
		changedPaths
	)

	await writeText(
		path.join(repoRoot, 'SETUP.md'),
		createSetupDocument(values, moduleOptions),
		args.dryRun,
		changedPaths
	)

	await cacheOptionalModuleSources(repoRoot, optionalModules, args.dryRun, changedPaths)
	await applyModuleCleanup(repoRoot, moduleOptions, optionalModules, args.dryRun, changedPaths)

	if (starterPackageDir !== nextStarterPackageDir) {
		await moveStarterPackage(starterPackageDir, nextStarterPackageDir, args.dryRun, changedPaths)
		await rewriteStarterReferences({
			root: args.dryRun ? starterPackageDir : nextStarterPackageDir,
			from: `packages/${starterPackageName}`,
			to: `packages/${packageDir}`,
			dryRun: args.dryRun,
			changedPaths
		})
	}

	if (changedPaths.length === 0) {
		console.log('No changes were needed.')
		process.exit(0)
	}

	console.log(args.dryRun ? 'Dry run complete. Planned changes:' : 'Template initialization complete. Updated:')

	for (const changedPath of changedPaths) {
		console.log(`- ${path.relative(repoRoot, changedPath)}`)
	}

	if (!args.dryRun) {
		await verifyTemplateGuard(repoRoot)
		console.log('')
		console.log('Installing workspace dependencies...')
		// Initializing a project deliberately changes package.json and must refresh the lockfile,
		// including when the installer runs under GitHub Actions where pnpm freezes it by default.
		await run('pnpm', ['install', '--no-frozen-lockfile'], {cwd: repoRoot})
		console.log('')
		console.log('Next steps:')
		console.log('- Run `pnpm -w validate` to verify the bootstrapped workspace.')
	}
} finally {
	await rl?.close()
}

async function readOptionalModules(root) {
	const modulesRoot = path.join(root, 'optional-modules')
	const entries = await readdir(modulesRoot, {withFileTypes: true})
	const modules = []

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue
		}

		const manifestPath = path.join(modulesRoot, entry.name, 'module.json')
		modules.push(JSON.parse(await readFile(manifestPath, 'utf8')))
	}

	return modules.sort((a, b) => a.id.localeCompare(b.id))
}

async function resolveModuleOptions(options, readline, modules, identity) {
	const preset = options.preset ?? 'internal-packages'
	assert(presets[preset], `Unknown preset "${preset}". Expected one of: ${Object.keys(presets).join(', ')}`)

	let enabled = new Set(presets[preset])

	if (options.modules) {
		// "none" is used by setup:module when the final optional module is removed.
		enabled = options.modules === 'none'
			? new Set()
			: new Set(options.modules.split(',').map((module) => module.trim()).filter(Boolean))
	}

	for (const moduleId of enabled) {
		assert(optionalModuleIds.includes(moduleId), `Unknown optional module "${moduleId}"`)
	}

	let registry = validateRegistryStrategy(options.registry ?? (enabled.has('registry-github') ? 'github' : 'npm'))

	if (!options.yes && readline && !options.registry) {
		const answer = (await readline.question(`Package registry [npm/github/both] [${registry}]: `)).trim().toLowerCase()

		if (answer) {
			registry = validateRegistryStrategy(answer)
		}
	}

	if (registry === 'github' || registry === 'both') {
		enabled.add('registry-github')
		assert(
			identity.scope.toLowerCase() === identity.repoOwner.toLowerCase(),
			'GitHub Packages requires --scope to match --repo-owner so package names are publishable by that GitHub owner or organization.'
		)
	}

	if (!options.yes && readline && !options.modules) {
		console.log('')
		console.log(`Optional tooling preset: ${preset}`)

		for (const module of modules) {
			const defaultEnabled = enabled.has(module.id)
			const answer = (await readline.question(`Enable ${module.label}? [${defaultEnabled ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase()

			if (answer === '') {
				continue
			}

			if (['y', 'yes'].includes(answer)) {
				enabled.add(module.id)
				continue
			}

			if (['n', 'no'].includes(answer)) {
				enabled.delete(module.id)
			}
		}
	}

	assert(
		!(enabled.has('registry-github') && registry === 'npm'),
		'registry-github requires --registry github or --registry both. Remove the module or select a GitHub Packages registry strategy.'
	)

	let changed = true
	while (changed) {
		changed = false
		for (const moduleId of [...enabled]) {
			const module = modules.find((entry) => entry.id === moduleId)
			for (const required of module?.requires ?? []) {
				if (!enabled.has(required)) {
					enabled.add(required)
					changed = true
				}
			}
		}
	}
	for (const moduleId of enabled) {
		const module = modules.find((entry) => entry.id === moduleId)
		for (const conflict of module?.conflicts ?? []) assert(!enabled.has(conflict), `${moduleId} conflicts with ${conflict}`)
	}

	if (registry === 'github' || registry === 'both') {
		enabled.add('registry-github')
	}

	let packageAccess = options['package-access']
	if (!packageAccess && !options.yes && readline) {
		packageAccess = (await readline.question('Publishable package access [public/restricted] [public]: ')).trim().toLowerCase() || 'public'
	}
	assert(packageAccess, '--package-access is required in non-interactive mode.')
	assert(['public', 'restricted'].includes(packageAccess), 'package-access must be public or restricted')
	assert(!(registry === 'both' && packageAccess === 'restricted'), 'registry=both supports only package-access=public')
	const actionPinning = options['action-pinning'] ?? 'versions'
	assert(['versions', 'sha'].includes(actionPinning), 'action-pinning must be versions or sha')
	return {
		preset,
		enabled,
		cleanup: options.cleanup !== false,
		devAuditBlocking: preset === 'public-strict' || options['dev-audit'] === 'blocking',
		publishingMode: validatePublishingMode(options['publish-auth'] ?? 'trusted-publishing'),
		actionPinning,
		packageAccess,
		registry
	}
}

function validateRegistryStrategy(value) {
	assert(['npm', 'github', 'both'].includes(value), 'registry must be one of: npm, github, both')
	return value
}

function validatePublishingMode(value) {
	assert(['trusted-publishing', 'npm-token'].includes(value), 'publish-auth must be trusted-publishing or npm-token')
	return value
}

function configureRootManifest(pkg, moduleOptions, modules) {
	const next = structuredClone(pkg)
	const enabled = moduleOptions.enabled
	const scripts = {
		typecheck: "pnpm -r --filter './packages/*' run typecheck",
		lint: pkg.scripts.lint,
		test: "pnpm -r --filter './packages/*' --if-present run test",
		build: "pnpm -r --filter './packages/*' run build",
		bootstrap: 'node ./scripts/setup-template.mjs',
		'init:template': 'node ./scripts/init-template.mjs',
		'setup:module': 'node ./scripts/setup-module.mjs',
		'guard:template': 'node ./scripts/template-guard.mjs',
		'check:manifests': 'node ./scripts/check-package-manifests.mjs',
		'check:optional-modules': 'node ./scripts/check-optional-modules.mjs',
		'check:workflows': 'node ./scripts/check-workflows.mjs',
		'check:agents': 'node ./scripts/check-agents.mjs',
		'smoke:archetypes': 'node ./scripts/smoke-check-archetypes.mjs',
		'validate:ci': 'node ./scripts/validate-ci.mjs',
		prepare: 'husky'
	}

	if (enabled.has('size-limit')) {
		scripts.size = "pnpm -r --filter './packages/*' --if-present run size"
	}

	if (enabled.has('dependency-cruiser')) {
		scripts.depcruise = 'depcruise --config .dependency-cruiser.cjs packages/**/src'
	}

	if (enabled.has('publint-attw')) {
		scripts.publint = "pnpm -r --filter './packages/*' --if-present run publint"
		scripts.attw = "pnpm -r --filter './packages/*' --if-present run attw"
		scripts['check:packed-artifacts'] = 'node ./scripts/check-packed-artifacts.mjs'
	}

	if (enabled.has('package-readiness')) {
		scripts.readiness = 'node ./scripts/package-readiness.mjs'
		scripts['readiness:json'] = 'node ./scripts/package-readiness.mjs --json'
		scripts['readiness:strict'] = 'node ./scripts/package-readiness.mjs --strict'
	}

	if (enabled.has('license-policy')) {
		scripts['check:licenses'] = 'node ./scripts/check-licenses.mjs'
	}

	if (enabled.has('migration-tools')) {
		scripts['smoke:package-tools'] = 'node ./scripts/smoke-check-package-tools.mjs'
		scripts['create:package'] = 'node ./scripts/create-package.mjs'
		scripts['copy:package'] = 'node ./scripts/copy-package-from-repo.mjs'
		scripts['deprecate:package'] = 'node ./scripts/deprecate-package.mjs'
	}

	if (enabled.has('security-audit')) {
		scripts['audit:prod'] = 'pnpm audit --prod --audit-level moderate'
		scripts['audit:dev'] = 'pnpm audit --dev --audit-level moderate'
	}

	if (enabled.has('release')) {
		scripts['release:preflight'] = 'node ./scripts/release-preflight.mjs'
		scripts['publish:packages'] = 'node ./scripts/publish-packages.mjs'
		scripts.changeset = 'changeset'
	}
	for (const module of modules.filter((entry) => enabled.has(entry.id))) {
		for (const script of module.scripts ?? []) {
			if (!scripts[script] && pkg.scripts?.[script]) scripts[script] = pkg.scripts[script]
		}
	}

	scripts.validate = createValidateScript(moduleOptions)
	next.scripts = scripts

	const dependencyOwners = new Map()
	for (const module of modules) {
		for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
			for (const dependency of Object.keys(module[field] ?? {})) {
				if (!dependencyOwners.has(`${field}:${dependency}`)) dependencyOwners.set(`${field}:${dependency}`, [])
				dependencyOwners.get(`${field}:${dependency}`).push(module.id)
			}
		}
	}
	for (const [key, owners] of dependencyOwners) {
		const [field, dependency] = key.split(':')
		const enabledOwner = owners.find((id) => enabled.has(id))
		if (enabledOwner) {
			const owner = modules.find((entry) => entry.id === enabledOwner)
			next[field] = {...next[field], [dependency]: owner[field][dependency]}
		} else if (next[field]) delete next[field][dependency]
	}

	return next
}

function createValidateScript(moduleOptions) {
	const enabled = moduleOptions.enabled
	const commands = [
		'pnpm guard:template',
		'pnpm check:manifests',
		'pnpm check:optional-modules',
		'pnpm check:workflows',
		'pnpm check:agents'
	]

	if (enabled.has('license-policy')) {
		commands.push('pnpm check:licenses')
	}

	commands.push('pnpm lint', 'pnpm typecheck', 'pnpm build', 'pnpm test')

	if (enabled.has('size-limit')) {
		commands.push('pnpm size')
	}

	if (enabled.has('dependency-cruiser')) {
		commands.push('pnpm depcruise')
	}

	if (enabled.has('publint-attw')) {
		commands.push('pnpm publint', 'pnpm attw', 'pnpm check:packed-artifacts')
	}

	if (enabled.has('package-readiness')) {
		commands.push(moduleOptions.preset === 'public-strict' ? 'pnpm readiness:strict' : 'pnpm readiness')
	}

	if (enabled.has('migration-tools')) {
		commands.push('pnpm smoke:package-tools')
	}

	for (const module of optionalModules.filter((entry) => enabled.has(entry.id))) {
		for (const command of module.validationCommands ?? []) {
			if (!commands.includes(command)) commands.push(command)
		}
	}

	return commands.join(' && ')
}

function configurePackageManifest(pkg, moduleOptions) {
	const next = structuredClone(pkg)
	const enabled = moduleOptions.enabled
	if (next.private !== true && next.name?.startsWith('@')) {
		next.publishConfig = {...next.publishConfig, access: moduleOptions.packageAccess}
	}

	if (!enabled.has('size-limit')) {
		delete next.scripts?.size
	}

	if (!enabled.has('publint-attw')) {
		delete next.scripts?.publint
		delete next.scripts?.attw
	}

	if (!enabled.has('dependency-cruiser')) {
		delete next.scripts?.depcruise
	}

	return next
}

function createCiWorkflow(moduleOptions) {
	const auditSteps = moduleOptions.enabled.has('security-audit')
		? `
      - name: Audit production dependencies
        run: pnpm -w audit:prod

      - name: Audit development dependencies
        run: pnpm -w audit:dev${moduleOptions.devAuditBlocking ? '' : '\n        continue-on-error: true'}
`
		: ''

	return applyActionPinning(`name: CI

on:
  pull_request:
  push:
    branches:
      - '**'

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

permissions:
${renderWorkflowPermissions({contents: 'read'}, moduleOptions)}

jobs:
  validate:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Setup pnpm
        uses: pnpm/action-setup@v6
        with:
          version: 11.20.0

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: 22.14.0
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile
${auditSteps}
      - name: Validate workspace
        run: pnpm -w validate:ci
`, moduleOptions.actionPinning)
}

function createReleaseWorkflow(moduleOptions) {
	const permissions = {
		contents: 'write',
		'pull-requests': 'write',
		...(moduleOptions.publishingMode === 'trusted-publishing' ? {'id-token': 'write'} : {}),
		...(['github', 'both'].includes(moduleOptions.registry) ? {packages: 'write'} : {})
	}
	const trustedPublishingSetup = moduleOptions.publishingMode === 'trusted-publishing'
		&& ['npm', 'both'].includes(moduleOptions.registry)
		? `
      - name: Upgrade npm for trusted publishing
        run: npm install --global npm@12.0.2
`
		: ''
	const packedArtifactVerification = moduleOptions.enabled.has('publint-attw')
		? `
      - name: Verify publish artifacts
        if: \${{ github.event_name != 'workflow_dispatch' || !inputs.dry_run }}
        run: pnpm -w check:packed-artifacts
`
		: ''
	return applyActionPinning(`name: Release

on:
  push:
    branches:
      - main
  workflow_dispatch:
    inputs:
      dry_run:
        description: Run release validation without publishing
        required: true
        default: true
        type: boolean

permissions:
${renderWorkflowPermissions(permissions, moduleOptions)}

jobs:
  release:
    runs-on: ubuntu-latest
    env:
      NPM_CONFIG_PROVENANCE: true
      REGISTRY_STRATEGY: ${moduleOptions.registry}

    steps:
      - name: Checkout
        uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Setup pnpm
        uses: pnpm/action-setup@v6
        with:
          version: 11.20.0

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: 22.14.0
          cache: pnpm
          registry-url: https://registry.npmjs.org
${trustedPublishingSetup}

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Release preflight dry-run
        if: \${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}
        run: pnpm -w release:preflight -- --dry-run

      - name: Release preflight
        if: \${{ github.event_name != 'workflow_dispatch' || !inputs.dry_run }}
        run: pnpm -w release:preflight

      - name: Validate workspace
        run: pnpm -w validate

      - name: Release dry-run completed
        if: \${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}
        run: |
          echo "Release validation completed. Publishing was skipped because dry_run=true."

      - name: Build publish artifacts
        if: \${{ github.event_name != 'workflow_dispatch' || !inputs.dry_run }}
        run: pnpm -w build
${packedArtifactVerification}
      - name: Version and publish packages
        if: \${{ github.event_name != 'workflow_dispatch' || !inputs.dry_run }}
        uses: changesets/action@v1
        with:
          commit: Version Packages
          title: Version Packages
          version: pnpm -w changeset version
          publish: pnpm -w publish:packages
        env:
          GITHUB_TOKEN: \${{ secrets.RELEASE_TOKEN != '' && secrets.RELEASE_TOKEN || github.token }}
          GITHUB_PACKAGES_TOKEN: \${{ secrets.GITHUB_PACKAGES_TOKEN }}
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`, moduleOptions.actionPinning)
}

function renderWorkflowPermissions(base, moduleOptions) {
	const rank = {none: 0, read: 1, write: 2}
	const permissions = {...base}
	for (const module of optionalModules.filter((entry) => moduleOptions.enabled.has(entry.id))) {
		for (const [permission, level] of Object.entries(module.workflowPermissions ?? {})) {
			if ((rank[level] ?? 0) > (rank[permissions[permission]] ?? 0)) permissions[permission] = level
		}
	}
	return Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b)).map(([name, level]) => `  ${name}: ${level}`).join('\n')
}

function rewriteReadmeForModules(readme, moduleOptions) {
	const start = readme.indexOf('## Optional tooling installer')
	const end = readme.indexOf('## Troubleshooting')

	if (start === -1 || end === -1 || end <= start) {
		return readme
	}

	const managedSections = [
		createReadmeInstallerSection(moduleOptions),
		createReadmeToolingSection(moduleOptions),
		createReadmeCiSection(moduleOptions)
	].filter(Boolean).join('\n')

	return `${readme.slice(0, start)}${managedSections}${readme.slice(end)}`
}

function createReadmeInstallerSection(moduleOptions) {
	const moduleLines = optionalModules.map((module) => {
		const status = moduleOptions.enabled.has(module.id) ? 'enabled' : 'disabled'
		return `- \`${module.id}\` — ${status}; ${module.description}`
	})

	return `## Optional tooling installer

This repository was generated from a mandatory core plus optional tooling modules. Re-run \`pnpm init:template -- --dry-run\` to preview changes before reconfiguring the template.

Registry strategy: \`${moduleOptions.registry}\`

Enabled module state:

${moduleLines.join('\n')}

Disabled modules are removed by default from scripts, workflows, docs and files. Use \`--no-cleanup\` when you want to leave optional source files in place for later.

`
}

function createReadmeToolingSection(moduleOptions) {
	const sections = []

	if (moduleOptions.enabled.has('renovate')) {
		sections.push(`## Dependency automation

Renovate is enabled by default for this generated repository. It runs weekly for npm/pnpm dependencies, lockfile maintenance, and GitHub Actions updates. Automerge is disabled so maintainers review updates before merging.`)
	}

	if (moduleOptions.enabled.has('security-audit') || moduleOptions.enabled.has('license-policy')) {
		const bullets = []

		if (moduleOptions.enabled.has('security-audit')) {
			bullets.push('- `pnpm -w audit:prod` blocks CI on production advisories at `moderate` or higher.')
			bullets.push(`- \`pnpm -w audit:dev\` ${moduleOptions.devAuditBlocking ? 'blocks CI' : 'runs in CI as a warning/non-blocking job'} for development dependency advisories.`)
		}

		if (moduleOptions.enabled.has('license-policy')) {
			bullets.push('- `pnpm -w check:licenses` blocks validation when installed packages use licenses outside `license-policy.json`.')
		}

		sections.push(`## Security checks

${bullets.join('\n')}`)
	}

	if (moduleOptions.enabled.has('release')) {
		sections.push(`## Release safety

Release supports classic \`NPM_TOKEN\` and npm trusted publishing for npm, plus GitHub Packages publishing when the registry strategy is \`github\` or \`both\`. Before publishing, \`pnpm -w release:preflight\` verifies that the required credentials for \`${moduleOptions.registry}\` are present. The release workflow also supports manual \`workflow_dispatch\` with \`dry_run=true\` for validation without publishing.

Recommended branch protection:

- Protect \`main\`.
- Require CI to pass before merge.
- Require review for release PRs generated by Changesets.
- Disable direct pushes to \`main\`.`)
	}

	if (moduleOptions.enabled.has('package-readiness')) {
		sections.push(`## Package readiness

Package readiness is enabled as ${moduleOptions.preset === 'public-strict' ? 'a strict release gate' : 'an advisory report'}. It summarizes package metadata, docs, export surface, packed size, quality scripts, changeset state and public-facing leakage warnings.

\`\`\`sh
pnpm -w readiness
pnpm -w readiness:json
pnpm -w readiness:strict
\`\`\`

Use \`package-readiness.config.json\` to adjust thresholds for large intentional packages, for example service suites with many public subpaths.`)
	}

	if (moduleOptions.enabled.has('registry-github')) {
		sections.push(`## GitHub Packages

GitHub Packages support is enabled with registry strategy \`${moduleOptions.registry}\`. Keep package manifests registry-neutral: do not add \`publishConfig.registry\`, because \`both\` needs to publish the same package version to more than one registry.

Checklist:

- Package names should be scoped to the GitHub owner or organization scope.
- Release workflows need \`packages: write\`.
- Private/internal consumers need npm auth, usually via \`.npmrc\` or CI user config.
- Use \`GITHUB_PACKAGES_TOKEN\` when a dedicated package token is preferred; otherwise the workflow can use \`GITHUB_TOKEN\`.`)
	}

	if (moduleOptions.enabled.has('migration-tools')) {
		sections.push(`## For internal package splits

This template can extract reusable packages from larger monorepos into focused package repos, for example \`ooops-suite\` to \`ooops-cms-packages\` or \`ooops-analytics-packages\`.

\`\`\`sh
pnpm -w copy:package -- --from ../ooops-cms-packages/packages/cms-api
pnpm -w create:package -- --name @your-scope/new-package --archetype public-package
pnpm -w deprecate:package -- --package @your-scope/old-package
\`\`\`

Migration scripts support dry-run behavior and never commit changes. The deprecation helper is dry-run by default and only calls \`npm deprecate\` when \`--execute\` is passed.`)
	}

	if (sections.length === 0) {
		return ''
	}

	return `${sections.join('\n\n')}\n\n`
}

function createReadmeCiSection(moduleOptions) {
	const lines = [
		'## CI and release',
		'',
		'The bundled GitHub Actions workflows are local to the repository.',
		'',
		'- CI uses `pnpm -w validate:ci`, which is template-aware:',
		'  - before bootstrap it runs a template-safe profile so the fresh template repo stays green',
		'  - after bootstrap it automatically runs the full `pnpm -w validate` pipeline'
	]

	if (moduleOptions.enabled.has('security-audit')) {
		lines.push(`- CI also runs \`pnpm -w audit:prod\` as blocking and \`pnpm -w audit:dev\` as ${moduleOptions.devAuditBlocking ? 'blocking' : 'non-blocking'}.`)
	}

	if (moduleOptions.enabled.has('release')) {
		lines.push('- Release stays strict and always uses `pnpm -w validate`.')
		lines.push('- Release runs `pnpm -w release:preflight` before publish and supports manual dry-run validation through `workflow_dispatch`.')
		lines.push(`- Package publishing uses registry strategy \`${moduleOptions.registry}\`.`)
	}

	return `${lines.join('\n')}\n\n`
}

function createSetupDocument(values, moduleOptions) {
	const enabledModules = optionalModules
		.filter((module) => moduleOptions.enabled.has(module.id))
		.map((module) => `- ${module.label} (\`${module.id}\`)`)

	const releaseChecklist = moduleOptions.enabled.has('release')
		? createReleaseChecklist(moduleOptions)
		: ['- Release module disabled. Add release tooling later if this repo will publish packages.']

	const securityChecklist = [
		moduleOptions.enabled.has('security-audit') ? '- Production dependency audit enabled.' : '- Security audit module disabled.',
		moduleOptions.enabled.has('license-policy') ? '- License policy check enabled.' : '- License policy module disabled.',
		moduleOptions.enabled.has('package-readiness') ? `- Package readiness enabled in ${moduleOptions.preset === 'public-strict' ? 'strict' : 'advisory'} mode.` : '- Package readiness module disabled.',
		moduleOptions.actionPinning === 'sha' ? '- GitHub Actions use mapped full commit SHA pins; add every new action to the checked-in action map.' : '- GitHub Actions use version-pinned actions by default.'
	]

	return `# Setup

Generated by \`pnpm init:template\`.

## Project

- Workspace: \`${scopedName(values.scope, values.workspaceName)}\`
- Starter package: \`${scopedName(values.scope, values.packageName)}\`
- Repository: \`https://github.com/${values.repoOwner}/${values.repoName}\`
- Preset: \`${moduleOptions.preset}\`
- Publish auth preference: \`${moduleOptions.publishingMode}\`
- Registry strategy: \`${moduleOptions.registry}\`
- Package access: \`${moduleOptions.packageAccess}\`
- GitHub Actions pinning: \`${moduleOptions.actionPinning}\`

## Enabled modules

${enabledModules.length > 0 ? enabledModules.join('\n') : '- No optional tooling modules enabled.'}

## Optional module lifecycle

Disabled module sources are stored in \`.optional-module-cache\` so they can be restored without downloading the template again.

\`\`\`sh
pnpm setup:module list
pnpm setup:module add <module-id>
pnpm setup:module remove <module-id>
pnpm setup:module status
\`\`\`

Use an explicit registry transition for GitHub Packages:

\`\`\`sh
pnpm setup:module add registry-github --registry github
pnpm setup:module remove registry-github --registry npm
\`\`\`

## Release checklist

${releaseChecklist.join('\n')}

## CI and security checklist

${securityChecklist.join('\n')}

## Next steps

- Run \`pnpm install\`.
- Run \`pnpm -w validate:ci\`.
- If package readiness reports large intentional packages, add package-specific overrides in \`package-readiness.config.json\`.
- Review package README files and package metadata before the first release.
`
}

function createReleaseChecklist(moduleOptions) {
	const checklist = [
		'- Protect `main` and require CI before merge.',
		'- Run the Release workflow with `dry_run=true` before the first publish.'
	]

	if (moduleOptions.registry === 'npm' || moduleOptions.registry === 'both') {
		checklist.unshift('- Configure npm trusted publishing or `NPM_TOKEN`.')
	}

	if (moduleOptions.registry === 'github' || moduleOptions.registry === 'both') {
		checklist.unshift('- Confirm package scopes match the GitHub owner or organization.')
		checklist.unshift('- Configure `GITHUB_PACKAGES_TOKEN` if `GITHUB_TOKEN` is not enough for your package policy.')
	}

	return checklist
}

async function applyModuleCleanup(root, moduleOptions, modules, dryRun, changedPaths) {
	if (!moduleOptions.cleanup) {
		return
	}

	for (const module of modules) {
		if (moduleOptions.enabled.has(module.id)) {
			continue
		}

		for (const file of module.files) {
			await removePath(path.join(root, resolveModulePath(file)), dryRun, changedPaths)
		}
		for (const archetype of module.packageArchetypes ?? []) {
			await removePath(path.join(root, resolveModulePath(archetype)), dryRun, changedPaths)
		}

		await removePath(path.join(root, 'optional-modules', module.id), dryRun, changedPaths)
	}

	function resolveModulePath(value) {
		return value.replaceAll('{{starterPackageDir}}', `packages/${path.basename(starterPackageDir)}`)
	}
}

async function cacheOptionalModuleSources(root, modules, dryRun, changedPaths) {
	const cacheRoot = path.join(root, '.optional-module-cache')
	const indexPath = path.join(cacheRoot, 'index.json')

	if (await fileExists(indexPath)) {
		return
	}

	if (dryRun) {
		changedPaths.push(cacheRoot)
		return
	}

	const files = []
	for (const module of modules) {
		const moduleCacheDir = path.join(cacheRoot, 'modules', module.id)
		await mkdir(path.dirname(moduleCacheDir), {recursive: true})
		await cp(path.join(root, 'optional-modules', module.id), moduleCacheDir, {recursive: true})

		for (const templatePath of [...module.files, ...(module.packageArchetypes ?? [])]) {
			const sourcePath = path.join(root, resolveOptionalModulePath(templatePath))
			if (!await fileExists(sourcePath)) continue
			const cachePath = path.join('files', module.id, Buffer.from(templatePath).toString('base64url'))
			const destinationPath = path.join(cacheRoot, cachePath)
			await mkdir(path.dirname(destinationPath), {recursive: true})
			await cp(sourcePath, destinationPath, {recursive: true})
			files.push({moduleId: module.id, templatePath, cachePath})
		}
	}

	await writeFile(indexPath, JSON.stringify({version: 1, modules, files}, null, '\t') + '\n')
	changedPaths.push(cacheRoot)
}

function resolveOptionalModulePath(templatePath) {
	return templatePath.replaceAll('{{starterPackageDir}}', `packages/${starterPackageName}`)
}

async function removePath(filePath, dryRun, changedPaths) {
	if (!await fileExists(filePath)) {
		return
	}

	if (!dryRun) {
		await rm(filePath, {recursive: true, force: true})
	}

	changedPaths.push(filePath)
}

async function rewriteStarterReferences({root, from, to, dryRun, changedPaths}) {
	for (const entry of await readdir(root, {withFileTypes: true})) {
		const target = path.join(root, entry.name)
		if (entry.isDirectory()) {
			await rewriteStarterReferences({root: target, from, to, dryRun, changedPaths})
			continue
		}
		if (!/\.(?:c?js|mjs|json|map|md|ts|tsx)$/.test(entry.name)) continue
		const source = await readFile(target, 'utf8')
		if (!source.includes(from)) continue
		if (!dryRun) await writeFile(target, source.replaceAll(from, to), 'utf8')
		changedPaths.push(target)
	}
}

async function resolveStarterPackageDir(root) {
	const preferredDir = path.join(root, 'demo')

	if (await fileExists(path.join(preferredDir, 'package.json'))) {
		return preferredDir
	}

	const entries = await readdir(root, {withFileTypes: true})
	const packageDirs = []

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue
		}

		const candidate = path.join(root, entry.name)

		if (await fileExists(path.join(candidate, 'package.json'))) {
			packageDirs.push(candidate)
		}
	}

	if (packageDirs.length === 1) {
		return packageDirs[0]
	}

	throw new Error('Could not determine the starter package directory. Expected packages/demo or exactly one package under packages/.')
}

async function resolveValue(flagName, cliValue, fallbackValue) {
	if (cliValue) {
		return cliValue.trim()
	}

	if (!rl) {
		throw new Error(`Missing required option --${flagName}. Run pnpm init:template --help for non-interactive usage.`)
	}

	const suffix = fallbackValue ? ` [${fallbackValue}]` : ''
	const answer = (await rl.question(`${labelFor(flagName)}${suffix}: `)).trim()

	return answer || fallbackValue
}

function shouldPrompt(options) {
	return !options.yes && process.stdin.isTTY && process.stdout.isTTY
}

function printSummary(values, currentStarterPackageName, moduleOptions) {
	console.log('')
	console.log('Bootstrap summary')
	console.log(`- Workspace package: ${scopedName(values.scope, values.workspaceName)}`)
	console.log(`- Starter package: ${scopedName(values.scope, values.packageName)}`)
	console.log(`- Starter directory: packages/${currentStarterPackageName} -> packages/${values.packageDir}`)
	console.log(`- Repository: https://github.com/${values.repoOwner}/${values.repoName}`)
	console.log(`- Tooling preset: ${moduleOptions.preset}`)
	console.log(`- Registry strategy: ${moduleOptions.registry}`)
	console.log(`- Enabled modules: ${[...moduleOptions.enabled].join(', ') || 'none'}`)
	console.log(`- Cleanup disabled modules: ${moduleOptions.cleanup ? 'yes' : 'no'}`)
	console.log('')
}

function defaultPackageDescription(currentDescription, packageName, repoName) {
	if (currentDescription && !/archetype|template/i.test(currentDescription)) {
		return currentDescription
	}

	if (packageName && repoName) {
		return `${packageName} package for the ${repoName} npm package workspace.`
	}

	if (packageName) {
		return `${packageName} package.`
	}

	return 'Package description.'
}

function sanitizeScope(value) {
	return value.replace(/^@/, '').trim()
}

function preferTemplateSafeValue(primaryValue, secondaryValue, placeholderValue) {
	if (primaryValue && primaryValue !== placeholderValue) {
		return primaryValue
	}

	if (secondaryValue && secondaryValue !== placeholderValue) {
		return secondaryValue
	}

	return ''
}

function scopedName(scope, name) {
	return `@${scope}/${name}`
}

function parseScopedName(value) {
	const match = /^@([^/]+)\/(.+)$/.exec(value ?? '')

	if (!match || /<.+>/.test(value ?? '')) {
		return {scope: '', name: ''}
	}

	return {scope: match[1], name: match[2]}
}

function parseRepositoryUrl(value) {
	const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value)

	if (!match) {
		return {owner: '', repo: ''}
	}

	return {
		owner: match[1],
		repo: match[2]
	}
}

function validateScope(value) {
	assert(/^[a-z0-9][a-z0-9._-]*$/.test(value), 'scope must be a valid npm scope segment without "@"')
}

function validatePackageSegment(value, label) {
	assert(/^[a-z0-9][a-z0-9._-]*$/.test(value), `${label} must be a valid npm package segment`)
}

function validatePackageDir(value) {
	assert(/^[a-z0-9][a-z0-9._-]*$/.test(value), 'package-dir must be a single path segment')
}

function validateRepositorySegment(value, label) {
	assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value), `${label} must contain only letters, numbers, dots, underscores, or hyphens`)
}

function validateDescription(value) {
	assert(typeof value === 'string' && value.trim().length > 0, 'package-description is required')
}

async function moveStarterPackage(fromDir, toDir, dryRun, changedPaths) {
	if (dryRun) {
		changedPaths.push(toDir)
		return
	}

	await rename(fromDir, toDir)
	changedPaths.push(toDir)
}

async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, 'utf8'))
}

async function readJsonOrFallback(filePath, fallback) {
	try {
		return await readJson(filePath)
	} catch(error) {
		if (error?.code === 'ENOENT') return fallback
		throw error
	}
}

async function writeJson(filePath, data, dryRun, changedPaths) {
	const currentText = await readFile(filePath, 'utf8')
	const nextText = `${JSON.stringify(data, null, detectIndent(currentText))}\n`
	await writeText(filePath, nextText, dryRun, changedPaths)
}

async function writeText(filePath, nextText, dryRun, changedPaths) {
	let currentText = ''

	try {
		currentText = await readFile(filePath, 'utf8')
	} catch(error) {
		if (error.code !== 'ENOENT') {
			throw error
		}
	}

	if (currentText === nextText) {
		return
	}

	if (!dryRun) {
		await writeFile(filePath, nextText)
	}

	changedPaths.push(filePath)
}

async function verifyTemplateGuard(root) {
	try {
		await run(process.execPath, [path.join(root, 'scripts', 'template-guard.mjs')], {cwd: root})
		console.log('')
		console.log('Template guard passed.')
	} catch(error) {
		console.log('')
		console.log('Template guard still reports remaining placeholders:')
		console.log(error.message)
	}
}

function detectIndent(content) {
	const match = /^(\s+)"[^"]+":/m.exec(content)
	return match?.[1] ?? '\t'
}

async function fileExists(filePath) {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

async function readGitRepositoryInfo(root) {
	try {
		const {stdout} = await run('git', ['remote', 'get-url', 'origin'], {
			cwd: root,
			capture: true
		})
		return parseRepositoryUrl(stdout.trim())
	} catch {
		return {owner: '', repo: ''}
	}
}

function labelFor(flagName) {
	return {
		scope: 'npm scope',
		'repo-owner': 'GitHub owner or org',
		'repo-name': 'repository name',
		'workspace-name': 'workspace package name',
		'package-name': 'starter package name',
		'package-dir': 'starter package directory',
		'package-description': 'starter package description'
	}[flagName]
}

function parseArgs(argv) {
	const result = {
		dryRun: false,
		yes: false,
		help: false,
		cleanup: true
	}

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]

		if (argument === '--') {
			continue
		}

		if (argument === '--dry-run') {
			result.dryRun = true
			continue
		}

		if (argument === '--yes') {
			result.yes = true
			continue
		}

		if (argument === '--no-cleanup') {
			result.cleanup = false
			continue
		}

		if (argument === '--help' || argument === '-h') {
			result.help = true
			continue
		}

		if (!argument.startsWith('--')) {
			throw new Error(`Unexpected argument "${argument}". Run pnpm init:template --help for usage.`)
		}

		const [rawKey, inlineValue] = argument.slice(2).split('=')
		const key = rawKey

		if (inlineValue !== undefined) {
			result[key] = inlineValue
			continue
		}

		const nextValue = argv[index + 1]
		assert(nextValue && !nextValue.startsWith('--'), `Missing value for --${key}`)
		result[key] = nextValue
		index += 1
	}

	return result
}

function run(command, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
			env: process.env
		})

		let stdout = ''
		let stderr = ''

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString()
		})

		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString()
		})

		child.on('close', (code) => {
			if (code === 0) {
				resolve({stdout, stderr})
				return
			}

			reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}\n${stderr || stdout}`))
		})
	})
}

function printHelp() {
	console.log(`Bootstrap a generated repository by replacing the controlled template placeholders.

Usage:
  pnpm init:template
  pnpm init:template --scope acme --repo-owner acme --repo-name platform --workspace-name platform --package-name sdk --package-dir sdk --package-description "SDK package"

Options:
  --scope                 npm scope without "@"
  --repo-owner            GitHub user or organization
  --repo-name             GitHub repository name
  --workspace-name        root workspace package name
  --package-name          starter package name
  --package-dir           starter package directory under packages/
  --package-description   starter package description
  --preset                minimal-library, internal-packages, or public-strict
  --modules               comma-separated optional modules to enable, or "none"
  --no-cleanup            keep disabled optional module files in the generated repo
  --dev-audit             warning or blocking
  --publish-auth          trusted-publishing or npm-token
  --registry              npm, github, or both
  --package-access        public or restricted; required with --yes
  --action-pinning        versions or sha
  --dry-run               print the planned changes without writing files
  --yes                   skip the interactive confirmation
  --help, -h              show this message
`)
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message)
	}
}
