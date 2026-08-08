import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const args = parseArgs(process.argv.slice(2))
const config = await readConfig()
const monorepoConfig = await readMonorepoConfig()
const expectedPackageAccess = monorepoConfig.packageAccess ?? 'public'
const packages = await readPackages()
const changedState = await readChangedState()
const results = []

for (const packageInfo of packages) {
	if (args.package && packageInfo.manifest.name !== args.package) {
		continue
	}

	if (packageInfo.manifest.private === true && !args.includePrivate) {
		continue
	}

	if (args.changedOnly && !changedState.changedPackageDirs.has(packageInfo.dirName)) {
		continue
	}

	results.push(await checkPackage(packageInfo, config, changedState))
}

const summary = summarize(results)
const report = {
	generatedAt: new Date().toISOString(),
	strict: args.strict,
	packages: results,
	summary
}

if (args.json) {
	console.log(JSON.stringify(report, null, 2))
} else {
	printHumanReport(report)
}

if (summary.blocked > 0 || (args.strict && summary.needsReview > 0)) {
	process.exit(1)
}

async function checkPackage(packageInfo, baseConfig, changedState) {
	const manifest = packageInfo.manifest
	const overrides = baseConfig.packages?.[manifest.name] ?? {}
	const packageConfig = mergePackageConfig(baseConfig, overrides)
	const findings = []

	checkMetadata(packageInfo, findings)
	checkPublishSafety(packageInfo, findings)
	await checkDocs(packageInfo, packageConfig, findings)
	checkQualityScripts(packageInfo, findings)
	checkExports(packageInfo, packageConfig, findings)
	await checkPackageSize(packageInfo, packageConfig, findings)
	await checkLeakage(packageInfo, findings)
	checkReleaseState(packageInfo, changedState, findings)

	const filteredFindings = findings.filter(
		(finding) => !packageConfig.ignoredWarningCodes.includes(finding.code)
	)
	const status = statusForFindings(filteredFindings)

	return {
		name: manifest.name,
		dir: `packages/${packageInfo.dirName}`,
		private: manifest.private === true,
		stability: packageConfig.stability,
		status,
		findings: filteredFindings
	}
}

function checkMetadata(packageInfo, findings) {
	const manifest = packageInfo.manifest
	const manifestPath = `packages/${packageInfo.dirName}/package.json`

	for (const field of ['name', 'version', 'description', 'license']) {
		if (!isNonEmptyString(manifest[field])) {
			findings.push(blocked('missing-metadata', `${manifestPath} is missing "${field}".`))
		}
	}

	if (manifest.private === true) {
		return
	}

	if (!isNonEmptyString(manifest.repository?.url)) {
		findings.push(blocked('missing-repository', `${manifestPath} is missing "repository.url".`))
	}

	if (!isNonEmptyString(manifest.homepage)) {
		findings.push(blocked('missing-homepage', `${manifestPath} is missing "homepage".`))
	}

	if (!isNonEmptyString(manifest.bugs?.url)) {
		findings.push(blocked('missing-bugs-url', `${manifestPath} is missing "bugs.url".`))
	}
}

function checkPublishSafety(packageInfo, findings) {
	const manifest = packageInfo.manifest
	const manifestPath = `packages/${packageInfo.dirName}/package.json`

	if (manifest.type !== 'module') {
		findings.push(blocked('missing-esm-type', `${manifestPath} must set "type": "module".`))
	}

	if (!isNonEmptyString(manifest.engines?.node)) {
		findings.push(blocked('missing-node-engine', `${manifestPath} is missing "engines.node".`))
	}

	if (manifest.private === true) {
		return
	}

	if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
		findings.push(blocked('missing-files', `${manifestPath} must declare a non-empty "files" array.`))
	} else if (!manifest.files.includes('dist')) {
		findings.push(warning('files-without-dist', `${manifestPath} "files" should include "dist".`))
	}

	if (!manifest.exports || Object.keys(manifest.exports).length === 0) {
		findings.push(blocked('missing-exports', `${manifestPath} must declare a non-empty "exports" map.`))
	}

	if (manifest.name?.startsWith('@') && manifest.publishConfig?.access !== expectedPackageAccess) {
		findings.push(blocked('invalid-package-access', `${manifestPath} must set "publishConfig.access": "${expectedPackageAccess}".`))
	}

	if (manifest.publishConfig?.registry) {
		findings.push(needsReview('registry-locked-package', `${manifestPath} sets "publishConfig.registry"; this can break multi-registry publishing.`))
	}
}

async function checkDocs(packageInfo, packageConfig, findings) {
	for (const docPath of packageConfig.requiredDocs) {
		const absolutePath = path.join(packageInfo.dir, docPath)
		const relativePath = `packages/${packageInfo.dirName}/${docPath}`
		const content = await readOptionalText(absolutePath)

		if (!content) {
			findings.push(blocked('missing-readme', `${relativePath} is required.`))
			continue
		}

		if (!/install|installation|pnpm add|npm install/i.test(content)) {
			findings.push(warning('readme-missing-install', `${relativePath} should include installation guidance.`))
		}

		if (!/usage|quickstart|example|import\s+/.test(content)) {
			findings.push(warning('readme-missing-usage', `${relativePath} should include usage or example guidance.`))
		}

		if (!/licen[sc]e|MIT|Apache|ISC|BSD/i.test(content)) {
			findings.push(warning('readme-missing-license', `${relativePath} should mention the package license.`))
		}
	}
}

function checkQualityScripts(packageInfo, findings) {
	const scripts = packageInfo.manifest.scripts ?? {}

	for (const script of ['typecheck', 'build']) {
		if (!scripts[script]) {
			findings.push(blocked('missing-required-script', `${packageInfo.manifest.name} is missing "${script}" script.`))
		}
	}

	if (!scripts.test) {
		findings.push(warning('missing-test-script', `${packageInfo.manifest.name} has no "test" script.`))
	}

	for (const script of ['size', 'publint', 'attw', 'depcruise']) {
		if (!scripts[script]) {
			findings.push(warning('missing-optional-quality-script', `${packageInfo.manifest.name} has no "${script}" script.`))
		}
	}
}

function checkExports(packageInfo, packageConfig, findings) {
	const manifest = packageInfo.manifest
	const exportsMap = manifest.exports ?? {}
	const exportKeys = Object.keys(exportsMap)

	if (exportKeys.length >= packageConfig.maxExportSubpathsReview) {
		findings.push(needsReview('large-export-surface', `${manifest.name} exposes ${exportKeys.length} export subpaths.`))
	} else if (exportKeys.length >= packageConfig.maxExportSubpathsWarning) {
		findings.push(warning('large-export-surface', `${manifest.name} exposes ${exportKeys.length} export subpaths.`))
	}

	for (const exportKey of exportKeys) {
		if (/internal|private|src|test|fixture/i.test(exportKey)) {
			findings.push(needsReview('internal-looking-export', `${manifest.name} export "${exportKey}" looks internal.`))
		}
	}
}

async function checkPackageSize(packageInfo, packageConfig, findings) {
	if (packageInfo.manifest.private === true) {
		return
	}

	const size = await packedSize(packageInfo)

	if (!size) {
		findings.push(warning('pack-size-unavailable', `Could not compute package size for ${packageInfo.manifest.name}.`))
		return
	}

	const unpackedKb = Math.ceil(size.unpackedBytes / 1024)

	if (unpackedKb >= packageConfig.maxUnpackedSizeReviewKb) {
		findings.push(needsReview('large-unpacked-size', `${packageInfo.manifest.name} unpacked size is ${unpackedKb}KB.`))
	} else if (unpackedKb >= packageConfig.maxUnpackedSizeWarningKb) {
		findings.push(warning('large-unpacked-size', `${packageInfo.manifest.name} unpacked size is ${unpackedKb}KB.`))
	}
}

async function checkLeakage(packageInfo, findings) {
	const files = await listTextFiles(packageInfo.dir)
	const publicFacingFiles = files.filter((filePath) => {
		const relativePath = path.relative(packageInfo.dir, filePath)
		return !/(^|\/)(test|tests|fixtures|coverage|dist|node_modules)\//.test(relativePath)
	})
	const patterns = [
		['todo-marker', /\b(TODO|FIXME|HACK|XXX)\b/i],
		['debug-statement', /\b(console\.log|debugger)\b/],
		['secret-looking-text', /\b(secret|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token)\b/i]
	]

	for (const filePath of publicFacingFiles) {
		const content = await readOptionalText(filePath)
		const isMarkdown = filePath.endsWith('.md')

		for (const [code, pattern] of patterns) {
			if (isMarkdown && code === 'debug-statement') {
				continue
			}

			if (pattern.test(content)) {
				findings.push(warning(code, `${path.relative(repoRoot, filePath)} contains ${code.replaceAll('-', ' ')}.`))
				break
			}
		}
	}
}

function checkReleaseState(packageInfo, changedState, findings) {
	if (!changedState.available || !changedState.changedPackageDirs.has(packageInfo.dirName)) {
		return
	}

	if (!changedState.changedPackagesWithChangesets.has(packageInfo.manifest.name)) {
		findings.push(warning('missing-changeset', `${packageInfo.manifest.name} has changed files but no matching changeset.`))
	}
}

async function packedSize(packageInfo) {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'package-readiness-'))

	try {
		await run('pnpm', ['pack', '--pack-destination', tempRoot], {cwd: packageInfo.dir, capture: true})
		const tarballs = (await readdir(tempRoot)).filter((entry) => entry.endsWith('.tgz'))

		if (tarballs.length !== 1) {
			return null
		}

		const tarballPath = path.join(tempRoot, tarballs[0])
		const tarballStat = await stat(tarballPath)
		const {stdout: listing} = await run('tar', ['-tvf', tarballPath], {cwd: repoRoot, capture: true})
		const unpackedBytes = listing
			.split('\n')
			.map((line) => line.trim().split(/\s+/)[2])
			.map((value) => Number(value))
			.filter(Number.isFinite)
			.reduce((sum, value) => sum + value, 0)

		return {
			packedBytes: tarballStat.size,
			unpackedBytes
		}
	} catch {
		return null
	} finally {
		await rm(tempRoot, {recursive: true, force: true})
	}
}

async function readPackages() {
	const packagesRoot = path.join(repoRoot, 'packages')
	const entries = await readdir(packagesRoot, {withFileTypes: true})
	const result = []

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue
		}

		const dir = path.join(packagesRoot, entry.name)
		const manifestPath = path.join(dir, 'package.json')
		const manifestText = await readOptionalText(manifestPath)

		if (!manifestText) {
			continue
		}

		result.push({
			dir,
			dirName: entry.name,
			manifest: JSON.parse(manifestText)
		})
	}

	return result.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
}

async function readChangedState() {
	try {
		const {stdout} = await run('git', ['status', '--porcelain'], {cwd: repoRoot, capture: true})
		const changedPackageDirs = new Set()
		const changedChangesets = []

		for (const line of stdout.split('\n')) {
			const filePath = line.slice(3).trim()
			const packageMatch = /^packages\/([^/]+)\//.exec(filePath)

			if (packageMatch) {
				changedPackageDirs.add(packageMatch[1])
			}

			if (/^\.changeset\/.+\.md$/.test(filePath)) {
				changedChangesets.push(path.join(repoRoot, filePath))
			}
		}

		const changedPackagesWithChangesets = new Set()

		for (const changesetPath of changedChangesets) {
			const content = await readOptionalText(changesetPath)

			for (const packageInfo of packages) {
				if (content.includes(packageInfo.manifest.name)) {
					changedPackagesWithChangesets.add(packageInfo.manifest.name)
				}
			}
		}

		return {
			available: true,
			changedPackageDirs,
			changedPackagesWithChangesets
		}
	} catch {
		return {
			available: false,
			changedPackageDirs: new Set(),
			changedPackagesWithChangesets: new Set()
		}
	}
}

async function readConfig() {
	const defaults = {
		maxExportSubpathsWarning: 20,
		maxExportSubpathsReview: 50,
		maxUnpackedSizeWarningKb: 1024,
		maxUnpackedSizeReviewKb: 5120,
		requiredDocs: ['README.md'],
		stabilityLabels: ['stable', 'beta', 'experimental', 'internal'],
		packages: {}
	}
	const configText = await readOptionalText(path.join(repoRoot, 'package-readiness.config.json'))

	if (!configText) {
		return defaults
	}

	return {
		...defaults,
		...JSON.parse(configText),
		packages: {
			...defaults.packages,
			...JSON.parse(configText).packages
		}
	}
}

async function readMonorepoConfig() {
	const configText = await readOptionalText(path.join(repoRoot, 'monorepo.config.json'))

	if (!configText) return {}

	const monorepoConfig = JSON.parse(configText)
	return ['public', 'restricted'].includes(monorepoConfig.packageAccess)
		? monorepoConfig
		: {}
}

function mergePackageConfig(baseConfig, overrides) {
	const stability = overrides.stability ?? overrides.expectedStability ?? 'stable'

	return {
		...baseConfig,
		...overrides,
		requiredDocs: overrides.requiredDocs ?? baseConfig.requiredDocs,
		ignoredWarningCodes: overrides.ignoredWarningCodes ?? [],
		stability
	}
}

function statusForFindings(findings) {
	if (findings.some((finding) => finding.level === 'blocked')) {
		return 'blocked'
	}

	if (findings.some((finding) => finding.level === 'needs-review')) {
		return 'needs-review'
	}

	if (findings.some((finding) => finding.level === 'warning')) {
		return 'warning'
	}

	return 'ready'
}

function summarize(results) {
	const summary = {
		total: results.length,
		ready: 0,
		warning: 0,
		needsReview: 0,
		blocked: 0
	}

	for (const result of results) {
		if (result.status === 'needs-review') {
			summary.needsReview += 1
			continue
		}

		if (result.status === 'blocked') {
			summary.blocked += 1
			continue
		}

		summary[result.status] += 1
	}

	return summary
}

function printHumanReport(report) {
	console.log('Package readiness report')
	console.log(`Generated: ${report.generatedAt}`)
	console.log(`Mode: ${report.strict ? 'strict' : 'advisory'}`)
	console.log('')

	for (const result of report.packages) {
		console.log(`${statusIcon(result.status)} ${result.name} (${result.status}, ${result.stability})`)

		if (result.findings.length === 0) {
			console.log('  - No findings.')
			continue
		}

		for (const finding of result.findings) {
			console.log(`  - [${finding.level}] ${finding.code}: ${finding.message}`)
		}
	}

	console.log('')
	console.log(`Summary: ${report.summary.ready} ready, ${report.summary.warning} warning, ${report.summary.needsReview} needs review, ${report.summary.blocked} blocked.`)
}

function statusIcon(status) {
	return {
		ready: 'OK',
		warning: 'WARN',
		'needs-review': 'REVIEW',
		blocked: 'BLOCK'
	}[status]
}

async function listTextFiles(root) {
	const result = []
	const entries = await readdir(root, {withFileTypes: true})

	for (const entry of entries) {
		const filePath = path.join(root, entry.name)

		if (entry.isDirectory()) {
			if (['node_modules', 'dist', 'coverage', '.turbo'].includes(entry.name)) {
				continue
			}

			result.push(...await listTextFiles(filePath))
			continue
		}

		if (/\.(m?[jt]sx?|json|md|cjs|cts|mts|yml|yaml)$/.test(entry.name)) {
			result.push(filePath)
		}
	}

	return result
}

async function readOptionalText(filePath) {
	try {
		return await readFile(filePath, 'utf8')
	} catch(error) {
		if (error.code === 'ENOENT') {
			return ''
		}

		throw error
	}
}

function parseArgs(argv) {
	const parsed = {
		json: false,
		strict: false,
		includePrivate: false,
		changedOnly: false,
		package: ''
	}

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]

		if (argument === '--json') {
			parsed.json = true
			continue
		}

		if (argument === '--strict') {
			parsed.strict = true
			continue
		}

		if (argument === '--include-private') {
			parsed.includePrivate = true
			continue
		}

		if (argument === '--changed-only') {
			parsed.changedOnly = true
			continue
		}

		if (argument === '--package') {
			parsed.package = argv[index + 1]
			index += 1
			continue
		}

		throw new Error(`Unknown argument "${argument}".`)
	}

	return parsed
}

function isNonEmptyString(value) {
	return typeof value === 'string' && value.trim().length > 0
}

function warning(code, message) {
	return {level: 'warning', code, message}
}

function needsReview(code, message) {
	return {level: 'needs-review', code, message}
}

function blocked(code, message) {
	return {level: 'blocked', code, message}
}

function run(command, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
			env: process.env
		})

		let stdout = ''
		let stderr = ''

		child.stdout?.on('data', (chunk) => {
			stdout += chunk.toString()
		})

		child.stderr?.on('data', (chunk) => {
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

export function hashReport(report) {
	return createHash('sha256').update(JSON.stringify(report)).digest('hex')
}
