import {readFile, readdir} from 'node:fs/promises'
import path from 'node:path'

export const placeholderPatterns = [
	'<your-scope>',
	'<name>',
	'<pkg>',
	'repo-name.git'
]

export async function findTemplatePlaceholders(repoRoot) {
	const filesToCheck = await getPublishFacingFiles(repoRoot)
	const findings = []

	for (const filePath of filesToCheck) {
		const content = await readOptionalFile(filePath)

		if (content === null) {
			continue
		}

		for (const token of placeholderPatterns) {
			let startIndex = 0

			while (true) {
				const matchIndex = content.indexOf(token, startIndex)
				if (matchIndex === -1) {
					break
				}

				findings.push({
					filePath,
					token,
					line: content.slice(0, matchIndex).split('\n').length
				})
				startIndex = matchIndex + token.length
			}
		}
	}

	return findings
}

async function readOptionalFile(filePath) {
	try {
		return await readFile(filePath, 'utf8')
	} catch(error) {
		if (error.code === 'ENOENT') {
			return null
		}

		throw error
	}
}

async function getPublishFacingFiles(repoRoot) {
	const packagesRoot = path.join(repoRoot, 'packages')
	const entries = await readdir(packagesRoot, {withFileTypes: true})
	const packageDirs = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(packagesRoot, entry.name))

	const config = await readOptionalJson(path.join(repoRoot, 'monorepo.config.json'))
	const releaseEnabled = config?.enabledModules?.includes('release') ?? true

	return [
		path.join(repoRoot, 'package.json'),
		...(releaseEnabled ? [path.join(repoRoot, '.changeset', 'config.json')] : []),
		...packageDirs.map((dir) => path.join(dir, 'package.json'))
	]
}

async function readOptionalJson(filePath) {
	const content = await readOptionalFile(filePath)
	return content === null ? null : JSON.parse(content)
}
