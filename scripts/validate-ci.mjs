import {spawn} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {findTemplatePlaceholders} from './template-placeholders.mjs'

const repoRoot = process.cwd()
const rootManifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const findings = await findTemplatePlaceholders(repoRoot)

if (findings.length === 0) {
	console.log('No template placeholders detected. Running full validate pipeline.')
	await run('pnpm', ['validate'], repoRoot)
	process.exit(0)
}

console.log('Template placeholders detected. Running template-safe CI profile.')
console.log('Publish validation stays disabled until pnpm bootstrap or pnpm init:template replaces them.')

for (const finding of findings) {
	console.log(`- ${path.relative(repoRoot, finding.filePath)}:${finding.line} contains "${finding.token}"`)
}

const templateSafeChecks = [
	'check:manifests',
	'check:optional-modules',
	'check:workflows',
	'check:agents',
	'check:licenses',
	'test:installer-policies',
	'lint',
	'typecheck',
	'build',
	'test',
	'size',
	'depcruise',
	'smoke:archetypes',
	'smoke:package-tools'
].filter((script) => rootManifest.scripts?.[script])

for (const script of templateSafeChecks) {
	await run('pnpm', [script], repoRoot)
}

function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: 'inherit',
			env: process.env
		})

		child.on('close', (code) => {
			if (code === 0) {
				resolve()
				return
			}

			reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`))
		})
	})
}
