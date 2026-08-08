import path from 'node:path'
import process from 'node:process'

import {findTemplatePlaceholders} from './template-placeholders.mjs'

const repoRoot = process.cwd()
const findings = await findTemplatePlaceholders(repoRoot)

if (findings.length > 0) {
	console.error('Template guard failed. Replace placeholder values in publish-facing manifests before running publish validation:')
	for (const finding of findings) {
		console.error(`- ${path.relative(repoRoot, finding.filePath)}:${finding.line} contains "${finding.token}"`)
	}
	process.exit(1)
}
