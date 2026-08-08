import {spawn} from 'node:child_process'
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const packagesRoot = path.join(repoRoot, 'packages')
const packages = await getPublishablePackages(packagesRoot)
const typescriptCli = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const rootManifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const packageLocalDirs = packages.flatMap((packageInfo) =>
	Object.values({
		...packageInfo.manifest.dependencies,
		...packageInfo.manifest.devDependencies,
		...packageInfo.manifest.peerDependencies
	})
		.filter((value) => typeof value === 'string' && value.startsWith('file:'))
		.map((value) => path.resolve(packageInfo.dir, value.slice('file:'.length)))
)
const rootLocalDirs = Object.values(rootManifest.pnpm?.overrides ?? {})
	.filter((value) => typeof value === 'string' && value.startsWith('file:'))
	.map((value) => path.resolve(repoRoot, value.slice('file:'.length)))
const localOverrideDirs = [...new Set([...rootLocalDirs, ...packageLocalDirs])]

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'packages-monorepo-template-pack-'))

try {
	const tarballDir = path.join(tempRoot, 'tarballs')
	const artifacts = []

	for (const pkgInfo of packages) {
		await run('pnpm', ['pack', '--pack-destination', tarballDir], {cwd: pkgInfo.dir})
		const tarballPath = await findPackageTarball(tarballDir, pkgInfo.name)
		artifacts.push({name: pkgInfo.name, path: tarballPath})
		pkgInfo.tarballFiles = await assertTarballContents(pkgInfo, tarballPath)
	}

	for (const overrideDir of localOverrideDirs) {
		await run('pnpm', ['pack', '--pack-destination', tarballDir], {cwd: overrideDir})
		const manifest = JSON.parse(await readFile(path.join(overrideDir, 'package.json'), 'utf8'))
		artifacts.push({name: manifest.name, path: await findPackageTarball(tarballDir, manifest.name)})
	}

	const consumerDir = path.join(tempRoot, 'consumer')
	await writeConsumerFixture(consumerDir, artifacts, packages)
	await run('pnpm', ['install'], {cwd: consumerDir})

	for (const pkgInfo of packages) {
		await writeConsumerChecks(consumerDir, pkgInfo, expandExportEntries(pkgInfo))
		if (pkgInfo.frameworkAdapter) {
			assertFrameworkAdapter(pkgInfo)
		} else {
			await run(process.execPath, ['consumer.mjs'], {cwd: consumerDir})
		}
		await run(process.execPath, [typescriptCli, '-p', 'tsconfig.json', '--noEmit'], {cwd: consumerDir})
	}
} finally {
	await rm(tempRoot, {recursive: true, force: true})
}

console.log(`Verified packed artifact installation and consumption for ${packages.length} publishable package(s).`)

async function getPublishablePackages(root) {
	const entries = await readdir(root, {withFileTypes: true})
	const result = []

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue
		}

		const dir = path.join(root, entry.name)
		const manifestPath = path.join(dir, 'package.json')
		const pkg = JSON.parse(await readFile(manifestPath, 'utf8'))

		if (pkg.private === true) {
			continue
		}

		result.push({
			name: pkg.name,
			dir,
			manifest: pkg,
			exportEntries: normalizeExportEntries(pkg.exports),
			frameworkAdapter: isFrameworkAdapter(pkg)
		})
	}

	return result
}

async function writeConsumerFixture(consumerDir, artifacts, packageInfos) {
	await run('mkdir', ['-p', consumerDir], {cwd: repoRoot})
	const artifactNames = new Set(artifacts.map((artifact) => artifact.name))
	const peerDependencies = {}
	for (const packageInfo of packageInfos) {
		for (const [name, range] of Object.entries(packageInfo.manifest.peerDependencies ?? {})) {
			if (!artifactNames.has(name) && typeof range === 'string') {
				peerDependencies[name] ??= testedPeerVersion(packageInfo, name, range)
			}
		}
	}
	const nodeTypesVersion = rootManifest.devDependencies?.['@types/node']
	const overrides = Object.fromEntries(
		artifacts.map((artifact) => [artifact.name, `file:${artifact.path}`])
	)
	await writeFile(path.join(consumerDir, 'package.json'), JSON.stringify({
		name: 'packed-artifact-consumer',
		private: true,
		type: 'module',
		dependencies: {
			...(typeof nodeTypesVersion === 'string' ? {'@types/node': nodeTypesVersion} : {}),
			...peerDependencies,
			...Object.fromEntries(artifacts.map((artifact) => [artifact.name, `file:${artifact.path}`]))
		}
	}, null, 2) + '\n')
	await writeFile(path.join(consumerDir, 'pnpm-workspace.yaml'), [
		'packages: []',
		'allowBuilds:',
		"  '@datadog/pprof': true",
		'  esbuild: true',
		'  unrs-resolver: true',
		'overrides:',
		...Object.entries(overrides).map(([name, target]) =>
			`  ${JSON.stringify(name)}: ${JSON.stringify(target)}`
		),
		''
	].join('\n'))
	await writeFile(path.join(consumerDir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			module: 'ESNext',
			moduleResolution: 'Bundler',
			target: 'ESNext',
			lib: ['ESNext', 'DOM', 'DOM.Iterable'],
			types: ['node'],
			noEmit: true,
			strict: true
		},
		include: ['consumer.ts']
	}, null, 2) + '\n')
}

function testedPeerVersion(packageInfo, name, fallbackRange) {
	const testedVersion = packageInfo.manifest.devDependencies?.[name]
	if (typeof testedVersion !== 'string' || /^(?:file|link|workspace):/u.test(testedVersion)) return fallbackRange
	return testedVersion
}

async function writeConsumerChecks(consumerDir, pkgInfo, exportEntries) {
	const runtimeSpecifiers = exportEntries
		.filter(([, definition]) => isRuntimeImportableExport(definition))
		.map(([entry]) => exportKeyToSpecifier(pkgInfo.name, entry))
	const typeSpecifiers = exportEntries
		.filter(([, definition]) => isTypeImportableExport(definition))
		.map(([entry]) => exportKeyToSpecifier(pkgInfo.name, entry))
	let consumerJs = runtimeSpecifiers.map((specifier) => `await import('${specifier}')`).join('\n') + '\n'
	const contextEntry = `${pkgInfo.name}/runtime/context`
	const explicitContextEntry = `${pkgInfo.name}/runtime/context/async-context`
	if (runtimeSpecifiers.includes(contextEntry)
		&& runtimeSpecifiers.includes(explicitContextEntry)) {
		consumerJs += [
			`const contextEntry = await import('${contextEntry}')`,
			`const explicitContextEntry = await import('${explicitContextEntry}')`,
			'const contextProbe = await contextEntry.runWithContextAsync(',
			'  async () => explicitContextEntry.getContext(),',
			"  {correlationId: 'packed-context-probe'}",
			')',
			"if (contextProbe?.correlationId !== 'packed-context-probe') {",
			"  throw new Error('Packed context entry points do not share runtime state')",
			'}',
			''
		].join('\n')
	}
	const rootEntry = runtimeSpecifiers.includes(pkgInfo.name) ? pkgInfo.name : undefined
	for (const [contractSubpath, classNames] of [
		['contracts/lifecycle', ['LifecycleError', 'LifecycleStartupError', 'LifecycleShutdownTimeoutError']],
		['contracts/resilience', ['ResilienceError', 'TimedOutError', 'BreakerOpenError', 'BulkheadOverflowError', 'RetryExhaustedError', 'ResilienceConfigurationError']]
	]) {
		const contractEntry = `${pkgInfo.name}/${contractSubpath}`
		if (!rootEntry || !runtimeSpecifiers.includes(contractEntry)) continue
		consumerJs += [
			'{',
			`  const rootEntry = await import('${rootEntry}')`,
			`  const contractEntry = await import('${contractEntry}')`,
			`  for (const className of ${JSON.stringify(classNames)}) {`,
			'    if (rootEntry[className] !== undefined',
			'      && contractEntry[className] !== undefined',
			'      && rootEntry[className] !== contractEntry[className]) {',
			'      throw new Error(`Packed entry points duplicate ${className}`)',
			'    }',
			'  }',
			'}',
			''
		].join('\n')
	}
	const consumerTs = typeSpecifiers.map((specifier) => `import '${specifier}'`).join('\n') + '\n'

	await writeFile(path.join(consumerDir, 'consumer.mjs'), consumerJs)
	await writeFile(path.join(consumerDir, 'consumer.ts'), consumerTs)
}

function isRuntimeImportableExport(exportDefinition) {
	const targets = collectExportTargets(exportDefinition)
	const runtimeTargets = targets.filter((target) => !target.endsWith('.d.ts'))

	return runtimeTargets.some((target) => /\.(?:[cm]?js|jsx|tsx?|mts|cts)$/.test(target))
}

function isTypeImportableExport(exportDefinition) {
	const targets = collectExportTargets(exportDefinition)
	return targets.some((target) => /\.(?:d\.ts|[cm]?js|jsx|tsx?|mts|cts|astro|svelte|vue)$/.test(target))
}

function isFrameworkAdapter(pkg) {
	const peerDependencies = Object.keys(pkg.peerDependencies ?? {})
	const frameworkPeers = new Set([
		'astro',
		'svelte',
		'react',
		'react-dom',
		'vue',
		'preact',
		'solid-js',
		'@angular/core'
	])
	return peerDependencies.some((dependency) => frameworkPeers.has(dependency))
}

function assertFrameworkAdapter(pkgInfo) {
	const peerDependencies = Object.keys(pkgInfo.manifest.peerDependencies ?? {})
	assert(peerDependencies.length > 0, `${pkgInfo.name} framework adapter must declare framework peer dependencies.`)
	assert(
		peerDependencies.some((dependency) =>
			isFrameworkAdapter({peerDependencies: {[dependency]: true}})
		),
		`${pkgInfo.name} framework adapter must declare a supported framework peer dependency.`
	)
}

async function findPackageTarball(tarballDir, packageName) {
	const normalizedName = packageName.replace(/^@/, '').replace('/', '-').replace(/[^a-zA-Z0-9._-]/g, '-')
	const tarballs = await readdir(tarballDir)
	const match = tarballs.find((entry) => entry.startsWith(`${normalizedName}-`) && entry.endsWith('.tgz'))
	assert(match, `Could not find packed artifact for ${packageName}`)
	return path.join(tarballDir, match)
}

function exportKeyToSpecifier(packageName, exportKey) {
	return exportKey === '.' ? packageName : `${packageName}/${exportKey.slice(2)}`
}

async function assertTarballContents(pkgInfo, tarballPath) {
	const {stdout} = await run('tar', ['-tf', tarballPath], {cwd: repoRoot, capture: true})
	const files = stdout.trim().split('\n').filter(Boolean)

	assert(files.includes('package/package.json'), `${pkgInfo.name} tarball must contain package/package.json`)
	assert(files.some((file) => file.startsWith('package/dist/')), `${pkgInfo.name} tarball must contain built files under package/dist/`)
	for (const target of collectExportTargets(pkgInfo.manifest.exports)) {
		if (!target.startsWith('./')) continue
		if (target.includes('*')) {
			assert(files.some((file) => matchesExportTarget(file, target)), `${pkgInfo.name} tarball is missing an artifact matching exported pattern ${target}`)
			continue
		}
		assert(
			files.includes(`package/${target.slice(2)}`),
			`${pkgInfo.name} tarball is missing exported artifact ${target}`
		)
	}

	const forbiddenPrefixes = [
		'package/src/',
		'package/test/',
		'package/coverage/'
	]

	for (const forbiddenPrefix of forbiddenPrefixes) {
		assert(
			!files.some((file) => file.startsWith(forbiddenPrefix)),
			`${pkgInfo.name} tarball must not include ${forbiddenPrefix}`
		)
	}

	return files
}

function collectExportTargets(value) {
	if (typeof value === 'string') return [value]
	if (!value || typeof value !== 'object') return []
	return Object.values(value).flatMap(collectExportTargets)
}

function normalizeExportEntries(exportsField) {
	if (typeof exportsField === 'string') return [['.', exportsField]]
	if (!exportsField || typeof exportsField !== 'object') return []
	const entries = Object.entries(exportsField)
	return entries.some(([key]) => key.startsWith('.')) ? entries : [['.', exportsField]]
}

function expandExportEntries(pkgInfo) {
	return pkgInfo.exportEntries.flatMap(([exportKey, definition]) => {
		if (!exportKey.includes('*')) return [[exportKey, definition]]
		const expandedKeys = new Set()
		for (const target of collectExportTargets(definition)) {
			if (!target.includes('*')) continue
			const matchingFiles = pkgInfo.tarballFiles.filter((candidate) =>
				matchesExportTarget(candidate, target)
			)
			for (const file of matchingFiles) {
				const captures = captureExportTarget(file, target)
				let expandedKey = exportKey
				for (const capture of captures) expandedKey = expandedKey.replace('*', capture)
				expandedKeys.add(expandedKey)
			}
		}
		return [...expandedKeys].map((expandedKey) => [expandedKey, definition])
	})
}

function matchesExportTarget(file, target) {
	return createExportTargetPattern(target).test(file)
}

function captureExportTarget(file, target) {
	const match = createExportTargetPattern(target).exec(file)
	return match?.slice(1) ?? []
}

function createExportTargetPattern(target) {
	const source = target.slice(2).split('*').map(escapeRegex).join('(.+)')
	return new RegExp(`^package/${source}$`)
}

function escapeRegex(value) {
	return value.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
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
			const text = chunk.toString()
			stdout += text
		})

		child.stderr.on('data', (chunk) => {
			const text = chunk.toString()
			stderr += text
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

function assert(condition, message) {
	if (!condition) {
		throw new Error(message)
	}
}
