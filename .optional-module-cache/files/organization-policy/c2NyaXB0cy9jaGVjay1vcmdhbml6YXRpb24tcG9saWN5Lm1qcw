import {readFile, readdir} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const config = JSON.parse(await readFile(path.join(root, 'organization-policy.json'), 'utf8'))
const packageDirs = (await readdir(path.join(root, 'packages'), {withFileTypes: true})).filter((entry) => entry.isDirectory())
const findings = []

const matches = (value, pattern) => new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`).test(value)

for (const entry of packageDirs) {
	const packageRoot = path.join(root, 'packages', entry.name)
	const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
	for (const rule of config.packageRules ?? []) {
		if (!matches(manifest.name, rule.match ?? '*')) continue
		const dependencies = {
			...manifest.dependencies,
			...manifest.devDependencies,
			...manifest.peerDependencies
		}
		for (const dependency of rule.requiredDependencies ?? []) {
			if (!dependencies[dependency]) findings.push(`${manifest.name} must depend on ${dependency}.`)
		}
		for (const dependency of rule.forbiddenDependencies ?? []) {
			if (dependencies[dependency]) findings.push(`${manifest.name} must not depend on ${dependency}.`)
		}
		for (const [dependency, range] of Object.entries(rule.requiredPeerDependencies ?? {})) {
			if (manifest.peerDependencies?.[dependency] !== range) findings.push(`${manifest.name} must peer-depend on ${dependency}@${range}.`)
		}
	}
}

const sourceFiles = await collectSourceFiles(path.join(root, 'packages'))
for (const file of sourceFiles) {
	const relative = path.relative(root, file)
	const source = await readFile(file, 'utf8')
	for (const rule of config.importRules ?? []) {
		if (!matches(relative, rule.from ?? '*')) continue
		for (const pattern of rule.forbidden ?? []) {
			if (source.includes(pattern)) findings.push(`${relative} contains forbidden import fragment "${pattern}".`)
		}
	}
	for (const rule of config.forbiddenSourcePatterns ?? []) {
		if (!matches(relative, rule.glob ?? '*')) continue
		if ((rule.allowFiles ?? []).some((allowed) => matches(relative, allowed))) continue
		for (const pattern of rule.patterns ?? []) {
			if (source.includes(pattern)) findings.push(`${relative} contains forbidden source fragment "${pattern}".`)
		}
	}
}

if (findings.length) throw new Error(`Organization policy failed:\n- ${findings.join('\n- ')}`)
console.log('Organization package policy passed.')

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function collectSourceFiles(directory) {
	const files = []
	for (const entry of await readdir(directory, {withFileTypes: true})) {
		const absolute = path.join(directory, entry.name)
		if (entry.isDirectory()) files.push(...await collectSourceFiles(absolute))
		else if (/\.(?:js|mjs|cjs|ts|tsx|svelte|astro)$/.test(entry.name)) files.push(absolute)
	}
	return files
}
