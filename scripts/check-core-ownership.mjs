import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const coreRoot = join(root, 'packages/core')
const forbiddenCoreFiles = [
	'src/runtime/memory',
	'src/runtime/observability',
	'src/runtime/network/public-https.ts',
	'src/contracts/observability.ts',
	'src/contracts/sink.ts',
	'src/ports/redis.ts'
]
const forbiddenSubpaths = [
	'@ooopsstudio/core/runtime/memory',
	'@ooopsstudio/core/runtime/observability',
	'@ooopsstudio/core/runtime/network/public-https',
	'@ooopsstudio/core/contracts/observability',
	'@ooopsstudio/core/contracts/sink',
	'@ooopsstudio/core/ports/redis'
]
const failures = []
const domainPackages = [
	'audit', 'cache', 'events', 'jobs', 'lifecycle', 'performance', 'profiling', 'rate-limit', 'resilience'
]
const rawObservabilityPackages = domainPackages.filter((name) => name !== 'lifecycle')
const sdkExports = [
	'./cache', './events', './events/zod', './events/asyncapi', './jobs', './faro-browser',
	'./performance', './performance-browser', './performance-db'
]
const sveltekitExports = ['./server', './actions']

for (const path of forbiddenCoreFiles) {
	if (existsSync(join(coreRoot, path))) failures.push(`forbidden core path exists: packages/core/${path}`)
}

const manifest = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8'))
for (const subpath of forbiddenSubpaths) {
	const exportKey = `.${subpath.slice('@ooopsstudio/core'.length)}`
	if (Object.hasOwn(manifest.exports ?? {}, exportKey)) failures.push(`forbidden core export exists: ${exportKey}`)
}

function visit(path) {
	for (const entry of readdirSync(path, {withFileTypes: true})) {
		if (['dist', 'coverage', 'node_modules'].includes(entry.name)) continue
		const target = join(path, entry.name)
		if (entry.isDirectory()) visit(target)
		else if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) {
			const source = readFileSync(target, 'utf8')
			for (const subpath of forbiddenSubpaths) {
				const exactImport = new RegExp(`['"]${subpath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`, 'u')
				if (exactImport.test(source)) failures.push(`${relative(root, target)} imports ${subpath}`)
			}
			if (/\bTOK\.Redis\b/u.test(source)) failures.push(`${relative(root, target)} references removed TOK.Redis`)
		}
	}
}

visit(join(root, 'packages'))

for (const packageName of ['events', 'jobs', 'profiling']) {
	const packageRoot = join(root, 'packages', packageName)
	const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
	if (!Object.hasOwn(packageManifest.exports ?? {}, './observability')) {
		failures.push(`packages/${packageName} must publish ./observability`)
	}
}

checkAdapterPackage('sdk', sdkExports, ['@ooopsstudio/core'])
checkAdapterPackage('sveltekit', sveltekitExports, ['@ooopsstudio/core', '@ooopsstudio/sdk'])

function checkAdapterPackage(packageName, requiredExports, allowedPackages) {
	const packageRoot = join(root, 'packages', packageName)
	const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
	if (Object.hasOwn(packageManifest.exports ?? {}, '.')) {
		failures.push(`packages/${packageName} must not publish a catch-all root export`)
	}
	for (const exportKey of requiredExports) {
		if (!Object.hasOwn(packageManifest.exports ?? {}, exportKey)) {
			failures.push(`packages/${packageName} must publish ${exportKey}`)
		}
	}
	for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
		for (const dependency of Object.keys(packageManifest[section] ?? {})) {
			if (dependency.startsWith('@ooopsstudio/') && !allowedPackages.includes(dependency)) {
				failures.push(`packages/${packageName} ${section} must not depend on ${dependency}`)
			}
		}
	}

	const scan = (path) => {
		for (const entry of readdirSync(path, {withFileTypes: true})) {
			const target = join(path, entry.name)
			if (entry.isDirectory()) scan(target)
			else if (/\.ts$/u.test(entry.name)) {
				const source = readFileSync(target, 'utf8')
				for (const match of source.matchAll(/from\s+['"](@ooopsstudio\/[^/'"]+)/gu)) {
					if (!allowedPackages.includes(match[1])) {
						failures.push(`${relative(root, target)} imports disallowed package ${match[1]}`)
					}
				}
				if (/@ooopsstudio\/services(?:\/|['"])/u.test(source)) {
					failures.push(`${relative(root, target)} imports legacy services code`)
				}
			}
		}
	}
	scan(join(packageRoot, 'src'))
}

const sdkRoot = join(root, 'packages/sdk/src')
if (/from\s+['"]zod(?:\/|['"])/u.test(readFileSync(join(sdkRoot, 'events.ts'), 'utf8'))) {
	failures.push('packages/sdk/src/events.ts must remain schema-agnostic; Zod belongs in events-zod.ts')
}
if (!/from\s+['"]zod(?:\/|['"])/u.test(readFileSync(join(sdkRoot, 'events-zod.ts'), 'utf8'))) {
	failures.push('packages/sdk/src/events-zod.ts must own the optional Zod integration')
}
for (const browserFile of ['performance-browser.ts', 'performance-browser-runtime.ts', 'faro-browser.ts']) {
	const source = readFileSync(join(sdkRoot, browserFile), 'utf8')
	if (/from\s+['"]node:/u.test(source)) failures.push(`packages/sdk/src/${browserFile} imports a Node built-in`)
}
for (const serverFile of ['cache.ts', 'events.ts', 'events-asyncapi.ts', 'jobs.ts', 'performance.ts', 'performance-db.ts']) {
	const source = readFileSync(join(sdkRoot, serverFile), 'utf8')
	if (/from\s+['"](?:web-vitals|@grafana\/faro-web-sdk)/u.test(source)) {
		failures.push(`packages/sdk/src/${serverFile} imports a browser-only optional integration`)
	}
}
if (/\bWebVitalMetric\b/u.test(readFileSync(join(coreRoot, 'src/contracts/performance.ts'), 'utf8'))) {
	failures.push('browser-only WebVitalMetric must be owned by the SDK, not core')
}

const sveltekitActions = readFileSync(join(root, 'packages/sveltekit/src/actions.ts'), 'utf8')
if (/from\s+['"](?:node:|@sveltejs\/kit)/u.test(sveltekitActions)) {
	failures.push('packages/sveltekit/src/actions.ts must remain browser-safe')
}

for (const packageName of domainPackages) {
	const packageRoot = join(root, 'packages', packageName)
	const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
	for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
		if (Object.hasOwn(packageManifest[section] ?? {}, '@ooopsstudio/bridges')) {
			failures.push(`packages/${packageName} ${section} must not depend on @ooopsstudio/bridges`)
		}
	}
}

for (const packageName of rawObservabilityPackages) {
	const publicFiles = []
	const collect = (path) => {
		for (const entry of readdirSync(path, {withFileTypes: true})) {
			const target = join(path, entry.name)
			if (entry.isDirectory()) collect(target)
			else if (entry.name === 'observability.ts' && target.includes('/public/')) publicFiles.push(target)
		}
	}
	collect(join(root, 'packages', packageName, 'src'))
	for (const file of publicFiles) {
		const source = readFileSync(file, 'utf8')
		if (/@ooopsstudio\/core\/ports\/(?:logging|errors|metrics)/u.test(source)) {
			failures.push(`${relative(root, file)} imports a concrete observability destination port`)
		}
		for (const imported of domainPackages) {
			if (imported !== packageName && new RegExp(`@ooopsstudio/${imported}(?:/|['"])`, 'u').test(source)) {
				failures.push(`${relative(root, file)} imports concrete domain package @ooopsstudio/${imported}`)
			}
		}
	}
}

const profilingObservability = join(root, 'packages/profiling/src/public/observability.ts')
if (/\bwireProfilingObservability\b/u.test(readFileSync(profilingObservability, 'utf8'))) {
	failures.push('profiling observability must expose raw attachment, not concrete wire mappings')
}

const bridgeRoot = join(root, 'packages/bridges/src')
visitBridge(bridgeRoot)
function visitBridge(path) {
	for (const entry of readdirSync(path, {withFileTypes: true})) {
		const target = join(path, entry.name)
		if (entry.isDirectory()) visitBridge(target)
		else if (/\.ts$/u.test(entry.name)) {
			const source = readFileSync(target, 'utf8')
			if (/@ooopsstudio\/(?:audit|cache|events|jobs|lifecycle|performance|profiling|rate-limit|resilience)\/(?!observability(?:['"]|$))/u.test(source)) {
				failures.push(`${relative(root, target)} imports a private or non-observability domain subpath`)
			}
			if (/@ooopsstudio\/services\//u.test(source)) failures.push(`${relative(root, target)} imports legacy services code`)
		}
	}
}

const aggregateSource = readFileSync(join(bridgeRoot, 'observability.ts'), 'utf8')
if (/^import .*from ['"]\.\/(?:audit|cache|events|jobs|lifecycle|performance|profiling|rate-limit|resilience)['"]/mu.test(aggregateSource)) {
	failures.push('bridges aggregate must load domain bridges dynamically')
}

for (const packageName of domainPackages) {
	const sourceRoot = join(root, 'packages', packageName, 'src')
	const scanWire = (path) => {
		for (const entry of readdirSync(path, {withFileTypes: true})) {
			const target = join(path, entry.name)
			if (entry.isDirectory()) scanWire(target)
			else if (/\.ts$/u.test(entry.name) && /\bwire[A-Z]\w*Observability\b/u.test(readFileSync(target, 'utf8'))) {
				failures.push(`${relative(root, target)} contains cross-domain observability mapping outside bridges`)
			}
		}
	}
	scanWire(sourceRoot)
}

if (failures.length > 0) {
	console.error(`Core ownership check failed:\n- ${failures.join('\n- ')}`)
	process.exit(1)
}

console.log('Core ownership boundaries are valid.')
