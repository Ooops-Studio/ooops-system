import {spawn} from 'node:child_process'
import {cp, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const sourceRoot = process.cwd()
const scenarios = [
	{registry: 'npm', access: 'restricted', pinning: 'sha', modules: 'organization-policy'},
	{registry: 'github', access: 'restricted', pinning: 'versions'},
	{registry: 'both', access: 'public', pinning: 'sha'}
]

for (const scenario of scenarios) await runScenario(scenario)
await runRejectedScenario()
await runOptionalModuleLifecycleScenario()
await runLastModuleRemovalScenario()
await runUnknownActionPinningScenario()
await runUnknownVersionActionScenario()
await runMappedActionPinningScenario()
await runNoCleanupReleaseScenario()
await runReadmeModuleReactivationScenario()
await runInvalidPublishingModeScenario()
await runGitHubScopeMismatchScenario()
await runRegistryModuleConsistencyScenario()
await runQuotedWorkflowScenario()
await runLocalWorkflowActionScenario()
await runStringExportsPackedArtifactScenario()
await runConditionalAndWildcardExportsPackedArtifactScenario()
await runPackageToolTargetSafetyScenario()
await runManifestDependencyCoverageScenario()
await runFailedModuleTransitionRollbackScenario()
await runCiLockfileUpdateScenario()

console.log('Installer registry, access, SHA pinning, module, and rename policies passed.')

async function runScenario(scenario) {
	const root = await createFixture()
	try {
		const args = installerArgs(scenario)
		if (scenario.modules) args.push('--modules', scenario.modules)
		await run(process.execPath, args, root)
		const config = await readJson(path.join(root, 'monorepo.config.json'))
		const manifest = await readJson(path.join(root, 'packages', 'core-lib', 'package.json'))
		assert(config.registryStrategy === scenario.registry, 'Registry strategy was not persisted.')
		assert(config.packageAccess === scenario.access, 'Package access was not persisted.')
		assert(config.actionPinning === scenario.pinning, 'Action pinning was not persisted.')
		assert(manifest.publishConfig?.access === scenario.access, 'Package access was not applied.')
		if (config.enabledModules.includes('release')) {
			const configOnlyEnv = {...process.env}
			delete configOnlyEnv.REGISTRY_STRATEGY
			const preflight = await runWithOutput(process.execPath, ['scripts/release-preflight.mjs', '--dry-run'], root, configOnlyEnv)
			assert(preflight.includes(`registry strategy: ${scenario.registry}`), 'Release preflight did not read monorepo.config.json.')
			const publish = await runWithOutput(process.execPath, ['scripts/publish-packages.mjs', '--dry-run'], root, configOnlyEnv)
			assert(publish.includes(`Publishing strategy: ${scenario.registry}`), 'Publish wrapper did not read monorepo.config.json.')
		}
		await assertNoStaleStarterReferences(path.join(root, 'packages', 'core-lib'))
		await run(process.execPath, ['scripts/check-optional-modules.mjs'], root)
		await run(process.execPath, ['scripts/check-package-manifests.mjs'], root)
		await run(process.execPath, ['scripts/check-workflows.mjs'], root)
		await run(process.execPath, ['scripts/check-agents.mjs'], root)
		if (scenario.access === 'restricted' && config.enabledModules.includes('package-readiness')) {
			const readiness = JSON.parse(await runWithOutput(process.execPath, ['scripts/package-readiness.mjs', '--json'], root))
			assert(!readiness.packages.some((pkg) => pkg.findings.some((finding) => finding.code === 'invalid-package-access')), 'Package readiness must accept the configured restricted access policy.')
		}
		if (scenario.modules === 'organization-policy') {
			await run(process.execPath, ['scripts/check-organization-policy.mjs'], root)
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runOptionalModuleLifecycleScenario() {
	const root = await createFixture()
	try {
		await run(process.execPath, [
			...installerArgs({registry: 'npm', access: 'public', pinning: 'versions'}),
			'--preset', 'minimal-library'
		], root)
		assert(await exists(path.join(root, '.optional-module-cache', 'index.json')), 'Optional module cache was not generated.')
		await run(process.execPath, ['scripts/setup-module.mjs', 'add', 'license-policy'], root)
		let config = await readJson(path.join(root, 'monorepo.config.json'))
		assert(config.enabledModules.includes('license-policy'), 'setup:module add did not enable the module.')
		assert((await readJson(path.join(root, 'package.json'))).scripts['check:licenses'], 'setup:module add did not restore module scripts.')
		await run(process.execPath, ['scripts/setup-module.mjs', 'add', 'publint-attw'], root)
		assert(await exists(path.join(root, 'node_modules', '.bin', 'publint')), 'setup:module add must install newly introduced module dependencies.')
		await run(process.execPath, ['scripts/setup-module.mjs', 'remove', 'license-policy'], root)
		config = await readJson(path.join(root, 'monorepo.config.json'))
		assert(!config.enabledModules.includes('license-policy'), 'setup:module remove did not disable the module.')
		const generatedManifest = await readJson(path.join(root, 'package.json'))
		assert(!('test:installer-policies' in generatedManifest.scripts), 'Generated repositories must not run source-template installer tests.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runLastModuleRemovalScenario() {
	const root = await createFixture()
	try {
		const args = installerArgs({registry: 'npm', access: 'public', pinning: 'versions'})
		args.push('--modules', 'license-policy')
		await run(process.execPath, args, root)
		await run(process.execPath, ['scripts/setup-module.mjs', 'remove', 'license-policy'], root)
		const config = await readJson(path.join(root, 'monorepo.config.json'))
		assert(config.enabledModules.length === 0, 'Removing the final module must not restore the preset defaults.')
		assert(!(await exists(path.join(root, '.changeset', 'config.json'))), 'Removing the final module must not restore release files.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runCiLockfileUpdateScenario() {
	const root = await createFixture()
	try {
		await run(
			process.execPath,
			installerArgs({registry: 'npm', access: 'public', pinning: 'versions'}),
			root,
			false,
			{CI: 'true'}
		)
		assert(await exists(path.join(root, 'pnpm-lock.yaml')), 'Installer must update the lockfile when CI is set.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runUnknownActionPinningScenario() {
	const root = await createFixture()
	try {
		await run(process.execPath, installerArgs({registry: 'npm', access: 'public', pinning: 'sha'}), root)
		const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml')
		await writeFile(workflowPath, `${await readFile(workflowPath, 'utf8')}\n      - uses: example/unknown-action@v1\n`)
		const result = await run(process.execPath, ['scripts/check-workflows.mjs'], root, true)
		assert(result !== 0, 'SHA pinning must reject unmapped actions.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runUnknownVersionActionScenario() {
	const root = await createFixture()
	try {
		await run(process.execPath, installerArgs({registry: 'npm', access: 'public', pinning: 'versions'}), root)
		const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml')
		await writeFile(workflowPath, `${await readFile(workflowPath, 'utf8')}\n      - uses: example/unknown-action@main\n`)
		const result = await run(process.execPath, ['scripts/check-workflows.mjs'], root, true)
		assert(result !== 0, 'Version pinning must reject unmapped external actions.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runMappedActionPinningScenario() {
	const root = await createFixture()
	try {
		await run(process.execPath, installerArgs({registry: 'npm', access: 'public', pinning: 'sha'}), root)
		const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml')
		const workflow = await readFile(workflowPath, 'utf8')
		await writeFile(workflowPath, workflow.replace(/actions\/checkout@[a-f0-9]{40} # v7/, `actions/checkout@${'0'.repeat(40)} # v7`))
		let result = await run(process.execPath, ['scripts/check-workflows.mjs'], root, true)
		assert(result !== 0, 'SHA pinning must reject a SHA that is not in the approved action map.')

		await writeFile(workflowPath, workflow.replace(' # v7', ''))
		result = await run(process.execPath, ['scripts/check-workflows.mjs'], root, true)
		assert(result !== 0, 'SHA pinning must require the version comment.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runNoCleanupReleaseScenario() {
	const root = await createFixture()
	try {
		const args = installerArgs({registry: 'npm', access: 'public', pinning: 'versions'})
		args.push('--preset', 'minimal-library', '--no-cleanup')
		await run(process.execPath, args, root)
		assert(await exists(path.join(root, '.changeset', 'config.json')), '--no-cleanup must retain inactive release sources.')
		await run(process.execPath, ['scripts/template-guard.mjs'], root)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runReadmeModuleReactivationScenario() {
	const root = await createFixture()
	try {
		const args = installerArgs({registry: 'npm', access: 'public', pinning: 'versions'})
		args.push('--preset', 'minimal-library')
		await run(process.execPath, args, root)
		let result = await run(process.execPath, ['scripts/setup-module.mjs', 'add', 'registry-github'], root, true)
		assert(result !== 0, 'registry-github must require an explicit registry transition.')
		await run(process.execPath, ['scripts/setup-module.mjs', 'add', 'registry-github', '--registry', 'github'], root)
		const config = await readJson(path.join(root, 'monorepo.config.json'))
		assert(config.registryStrategy === 'github', 'registry-github activation must update the registry strategy.')
		const readme = await readFile(path.join(root, 'README.md'), 'utf8')
		assert(readme.includes('GitHub Packages support is enabled'), 'README must be regenerated when a cleaned module is re-enabled.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runGitHubScopeMismatchScenario() {
	const root = await createFixture()
	try {
		const args = installerArgs({registry: 'github', access: 'public', pinning: 'versions'})
		const scopeIndex = args.indexOf('--scope')
		args[scopeIndex + 1] = 'different-owner'
		const result = await run(process.execPath, args, root, true)
		assert(result !== 0, 'GitHub registry setup must reject a scope that differs from the repository owner.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runRegistryModuleConsistencyScenario() {
	const root = await createFixture()
	try {
		const args = installerArgs({registry: 'npm', access: 'public', pinning: 'versions'})
		args.push('--preset', 'minimal-library', '--modules', 'registry-github')
		const result = await run(process.execPath, args, root, true)
		assert(result !== 0, 'registry-github must not be enabled with the npm-only registry strategy.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runQuotedWorkflowScenario() {
	const root = await createFixture()
	try {
		await run(process.execPath, installerArgs({registry: 'npm', access: 'public', pinning: 'sha'}), root)
		const workflowPath = path.join(root, '.github', 'workflows', 'extra.yaml')
		await writeFile(workflowPath, 'jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: "actions/checkout@v7"\n')
		const result = await run(process.execPath, ['scripts/check-workflows.mjs'], root, true)
		assert(result !== 0, 'SHA pinning must inspect quoted actions in every workflow file.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runLocalWorkflowActionScenario() {
	const root = await createFixture()
	try {
		await run(process.execPath, installerArgs({registry: 'npm', access: 'public', pinning: 'sha'}), root)
		const workflowPath = path.join(root, '.github', 'workflows', 'local-action.yml')
		await writeFile(workflowPath, 'jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./actions/local-check\n')
		await run(process.execPath, ['scripts/check-workflows.mjs'], root)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runStringExportsPackedArtifactScenario() {
	const root = await createFixture()
	try {
		await run(process.execPath, installerArgs({registry: 'npm', access: 'public', pinning: 'versions'}), root)
		const packageDir = path.join(root, 'packages', 'core-lib')
		const manifestPath = path.join(packageDir, 'package.json')
		const manifest = await readJson(manifestPath)
		manifest.exports = './dist/index.js'
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`)
		await run('pnpm', ['build'], packageDir)
		await writeFile(path.join(packageDir, 'dist', 'index.js'), "throw new Error('string exports runtime probe')\n")
		const result = await run(process.execPath, ['scripts/check-packed-artifacts.mjs'], root, true)
		assert(result !== 0, 'Packed-artifact checks must runtime-import a string-form root export.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runConditionalAndWildcardExportsPackedArtifactScenario() {
	const root = await createFixture()
	try {
		await run(process.execPath, installerArgs({registry: 'npm', access: 'public', pinning: 'versions'}), root)
		const packageDir = path.join(root, 'packages', 'core-lib')
		const manifestPath = path.join(packageDir, 'package.json')
		const manifest = await readJson(manifestPath)
		manifest.exports = {
			'.': {
				import: './dist/index.js',
				types: './dist/index.d.ts'
			},
			'./features/*': {
				import: './dist/features/*.js',
				types: './dist/features/*.d.ts'
			}
		}
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`)
		await run('pnpm', ['build'], packageDir)
		await run('mkdir', ['-p', path.join(packageDir, 'dist', 'features')], root)
		await writeFile(path.join(packageDir, 'dist', 'features', 'example.js'), 'export const example = true\n')
		await writeFile(path.join(packageDir, 'dist', 'features', 'example.d.ts'), 'export declare const example: boolean\n')
		await run(process.execPath, ['scripts/check-packed-artifacts.mjs'], root)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runPackageToolTargetSafetyScenario() {
	const root = await createFixture()
	try {
		await run(process.execPath, installerArgs({registry: 'npm', access: 'public', pinning: 'versions'}), root)
		let result = await run(process.execPath, ['scripts/create-package.mjs', '--name', '@acme/core', '--dir', 'core-lib'], root, true)
		assert(result !== 0, 'create-package must not overwrite an existing package without --force.')
		result = await run(process.execPath, ['scripts/copy-package-from-repo.mjs', '--from', 'packages/core-lib', '--to', 'packages/core-lib'], root, true)
		assert(result !== 0, 'copy-package must not overwrite an existing package without --force.')
		result = await run(process.execPath, ['scripts/copy-package-from-repo.mjs', '--from', 'packages/core-lib', '--to', path.join(root, '..', 'outside-package'), '--force'], root, true)
		assert(result !== 0, 'copy-package must reject external targets without an explicit escape hatch.')
		result = await run(process.execPath, ['scripts/copy-package-from-repo.mjs', '--from', 'packages/core-lib', '--to', 'packages/core-lib', '--force'], root, true)
		assert(result !== 0, 'copy-package must reject identical source and target directories even with --force.')
		result = await run(process.execPath, ['scripts/copy-package-from-repo.mjs', '--from', 'packages/core-lib', '--to', 'packages/core-lib/nested', '--force'], root, true)
		assert(result !== 0, 'copy-package must reject targets nested inside the source package.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runManifestDependencyCoverageScenario() {
	const root = await createFixture()
	try {
		await run(process.execPath, installerArgs({registry: 'npm', access: 'public', pinning: 'versions'}), root)
		const manifestPath = path.join(root, 'optional-modules', 'license-policy', 'module.json')
		const manifest = await readJson(manifestPath)
		manifest.dependencies = {'example-runtime-dependency': '^1.0.0'}
		manifest.peerDependencies = {'example-peer-dependency': '^1.0.0'}
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`)
		const result = await run(process.execPath, ['scripts/check-optional-modules.mjs'], root, true)
		assert(result !== 0, 'Optional module validation must enforce runtime and peer dependencies.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runFailedModuleTransitionRollbackScenario() {
	const root = await createFixture()
	try {
		const args = installerArgs({registry: 'npm', access: 'public', pinning: 'versions'})
		const scopeIndex = args.indexOf('--scope')
		args[scopeIndex + 1] = 'different-owner'
		args.push('--preset', 'minimal-library')
		await run(process.execPath, args, root)
		const result = await run(process.execPath, ['scripts/setup-module.mjs', 'add', 'registry-github', '--registry', 'github'], root, true)
		assert(result !== 0, 'An invalid registry transition must fail before mutating the generated repository.')
		const config = await readJson(path.join(root, 'monorepo.config.json'))
		assert(config.registryStrategy === 'npm', 'A rejected registry transition must preserve the existing registry strategy.')
		assert(!config.enabledModules.includes('registry-github'), 'A rejected registry transition must preserve enabled modules.')
		assert(!(await exists(path.join(root, '.npmrc.example'))), 'A rejected registry transition must not restore module-owned files.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runInvalidPublishingModeScenario() {
	const root = await createFixture()
	try {
		const args = installerArgs({registry: 'npm', access: 'public', pinning: 'versions'})
		args.push('--publish-auth', 'not-a-mode')
		const result = await run(process.execPath, args, root, true)
		assert(result !== 0, 'Installer must reject invalid publish-auth values.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

async function runRejectedScenario() {
	const root = await createFixture()
	try {
		const result = await run(process.execPath, installerArgs({
			registry: 'both',
			access: 'restricted',
			pinning: 'versions'
		}), root, true)
		assert(result !== 0, 'both + restricted must be rejected.')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}

function installerArgs({registry, access, pinning}) {
	const args = [
		'scripts/init-template.mjs',
		'--yes',
		'--scope', 'acme',
		'--repo-owner', 'acme',
		'--repo-name', `packages-${registry}-${access}`,
		'--workspace-name', 'packages',
		'--package-name', 'core',
		'--package-dir', 'core-lib',
		'--package-description', 'Installer policy fixture',
		'--preset', 'internal-packages',
		'--registry', registry,
		'--package-access', access,
		'--action-pinning', pinning
	]
	return args
}

async function createFixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'packages-template-policy-'))
	await cp(sourceRoot, root, {
		recursive: true,
		filter: (source) => !['.git', '.cache', 'node_modules'].includes(path.basename(source))
	})
	return root
}

async function assertNoStaleStarterReferences(root) {
	for (const entry of await readdir(root, {withFileTypes: true})) {
		const target = path.join(root, entry.name)
		if (entry.isDirectory()) {
			await assertNoStaleStarterReferences(target)
			continue
		}
		if (!/\.(?:c?js|json|map|md|ts|tsx)$/.test(entry.name)) continue
		assert(!(await readFile(target, 'utf8')).includes('packages/demo'), `${target} has a stale starter path.`)
	}
}

async function readJson(file) {
	return JSON.parse(await readFile(file, 'utf8'))
}

function run(command, args, cwd, allowFailure = false, env = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: allowFailure ? 'ignore' : 'pipe',
			env: {...process.env, ...env}
		})
		let output = ''
		child.stdout?.on('data', (chunk) => { output += chunk })
		child.stderr?.on('data', (chunk) => { output += chunk })
		child.on('close', (code) => {
			if (code === 0 || allowFailure) resolve(code)
			else reject(new Error(`${command} ${args.join(' ')} failed (${code}).\n${output}`))
		})
	})
}

function runWithOutput(command, args, cwd, env = process.env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {cwd, stdio: 'pipe', env})
		let output = ''
		child.stdout.on('data', (chunk) => { output += chunk })
		child.stderr.on('data', (chunk) => { output += chunk })
		child.on('close', (code) => code === 0
			? resolve(output)
			: reject(new Error(`${command} ${args.join(' ')} failed (${code}).\n${output}`)))
	})
}

async function exists(target) {
	try {
		await readFile(target)
		return true
	} catch {
		return false
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message)
}
