import {readFile, readdir} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const policyPath = path.join(repoRoot, 'license-policy.json')
const nodeModulesPath = path.join(repoRoot, 'node_modules')
const storePath = path.join(nodeModulesPath, '.pnpm')

const policy = JSON.parse(await readFile(policyPath, 'utf8'))
const allowedLicenses = new Set(policy.allowedLicenses ?? [])
const packageExceptions = policy.packageExceptions ?? {}
const findings = []

try {
	await readdir(storePath)
} catch {
	throw new Error('node_modules/.pnpm was not found. Run pnpm install before pnpm -w check:licenses.')
}

const manifests = await findInstalledPackageManifests(storePath)

for (const manifestPath of manifests) {
	const pkg = JSON.parse(await readFile(manifestPath, 'utf8'))
	const packageName = pkg.name

	if (!packageName || packageName === policy.name) {
		continue
	}

	if (packageExceptions[packageName] === true) {
		continue
	}

	const license = normalizeLicense(pkg.license ?? licensesArrayToString(pkg.licenses))
	if (!license) {
		findings.push(`${packageName} does not declare a license`)
		continue
	}

	if (!isAllowedLicense(license, allowedLicenses)) {
		findings.push(`${packageName} declares "${license}", which is not in license-policy.json`)
	}
}

if (findings.length > 0) {
	console.error('License policy check failed:')
	for (const finding of findings) {
		console.error(`- ${finding}`)
	}
	process.exit(1)
}

console.log(`License policy check passed for ${manifests.length} installed package manifests.`)

async function findInstalledPackageManifests(root) {
	const manifests = []
	const entries = await readdir(root, {withFileTypes: true})

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue
		}

		const nestedNodeModules = path.join(root, entry.name, 'node_modules')
		await collectPackageJsonFiles(nestedNodeModules, manifests)
	}

	return [...new Set(manifests)]
}

async function collectPackageJsonFiles(directory, manifests) {
	let entries

	try {
		entries = await readdir(directory, {withFileTypes: true})
	} catch {
		return
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue
		}

		if (entry.name.startsWith('@')) {
			await collectScopedPackageJsonFiles(path.join(directory, entry.name), manifests)
			continue
		}

		manifests.push(path.join(directory, entry.name, 'package.json'))
	}
}

async function collectScopedPackageJsonFiles(directory, manifests) {
	const entries = await readdir(directory, {withFileTypes: true})

	for (const entry of entries) {
		if (entry.isDirectory()) {
			manifests.push(path.join(directory, entry.name, 'package.json'))
		}
	}
}

function licensesArrayToString(licenses) {
	if (!Array.isArray(licenses)) {
		return ''
	}

	return licenses.map((license) => license?.type).filter(Boolean).join(' OR ')
}

function normalizeLicense(license) {
	if (typeof license !== 'string') {
		return ''
	}

	return license.trim().replaceAll('(', '').replaceAll(')', '')
}

function isAllowedLicense(license, allowed) {
	const parts = license
		.split(/\s+(?:OR|AND)\s+/u)
		.map((part) => part.trim())
		.filter(Boolean)

	return parts.some((part) => allowed.has(part))
}
