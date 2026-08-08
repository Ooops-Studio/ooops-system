import {access, readFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
await access(path.join(root, 'AGENTS.md'))

const active = await readFile(path.join(root, 'AGENTS.md'), 'utf8')
if (!active.includes('Package Repository Guidance') || !active.includes('## Required workflow')) throw new Error('Root AGENTS.md must contain the strict package repository guidance.')
for (const script of ['validate:ci', 'lint', 'typecheck', 'build', 'test']) {
	if (!manifest.scripts?.[script]) throw new Error(`AGENTS.md guidance requires missing pnpm script: ${script}.`)
}

console.log('Validated strict package repository AGENTS.md guidance.')
