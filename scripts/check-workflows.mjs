import {readFile, readdir} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {ACTION_REFERENCES} from './action-references.mjs'

const root = process.cwd()
const config = JSON.parse(await readFile(path.join(root, 'monorepo.config.json'), 'utf8'))
const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const workflowsRoot = path.join(root, '.github', 'workflows')
const workflows = await findWorkflowFiles(workflowsRoot)
const findings = []

for (const file of workflows) {
	const source = await readFile(file, 'utf8')
	for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))(?:\s*#\s*(\S+))?\s*$/gm)) {
		const action = match[1] ?? match[2] ?? match[3]
		if (action.startsWith('./')) continue
		const atIndex = action.lastIndexOf('@')
		const relativeFile = path.relative(root, file)
		if (atIndex <= 0) {
			findings.push(`${relativeFile} must use an explicit immutable or versioned action reference: ${action}.`)
			continue
		}
		const name = action.slice(0, atIndex)
		const ref = action.slice(atIndex + 1)
		const versionComment = match[4]
		if (!ACTION_REFERENCES[name]) {
			findings.push(`${relativeFile} uses unmapped external action ${name}. Add it to scripts/action-references.mjs before using it.`)
			continue
		}
		if (config.actionPinning === 'sha' && ref !== ACTION_REFERENCES[name].sha) {
			findings.push(`${relativeFile} must pin ${name} to the approved SHA in scripts/action-references.mjs.`)
		}
		if (config.actionPinning === 'sha' && versionComment !== ACTION_REFERENCES[name].version) {
			findings.push(`${relativeFile} must annotate ${name} with # ${ACTION_REFERENCES[name].version}.`)
		}
		if (config.actionPinning === 'versions' && ref !== ACTION_REFERENCES[name].version) {
			findings.push(`${relativeFile} must use ${name}@${ACTION_REFERENCES[name].version}.`)
		}
	}
	validatePublishPreparation(source, path.relative(root, file))
}

if (findings.length) throw new Error(`Workflow policy failed:\n- ${findings.join('\n- ')}`)
console.log(`Workflow action references follow the ${config.actionPinning} policy.`)

function validatePublishPreparation(source, relativeFile) {
	const jobs = splitWorkflowJobs(source)
	for (const [jobName, jobSource] of jobs) {
		const publishIndex = jobSource.indexOf('pnpm -w publish:packages')
		if (publishIndex === -1) continue
		const preparation = jobSource.slice(0, publishIndex)
		if (!preparation.includes('pnpm -w build')) {
			findings.push(`${relativeFile} job ${jobName} must build publish artifacts in the same job before publishing.`)
		}
		if (rootManifest.scripts?.['check:packed-artifacts'] && !preparation.includes('pnpm -w check:packed-artifacts')) {
			findings.push(`${relativeFile} job ${jobName} must verify packed artifacts in the same job before publishing.`)
		}
	}
}

function splitWorkflowJobs(source) {
	const lines = source.split('\n')
	const jobs = new Map()
	let inJobs = false
	let currentJob
	let currentLines = []

	const flush = () => {
		if (currentJob) jobs.set(currentJob, currentLines.join('\n'))
	}

	for (const line of lines) {
		if (line === 'jobs:') {
			inJobs = true
			continue
		}
		if (!inJobs) continue
		const jobMatch = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line)
		if (jobMatch) {
			flush()
			currentJob = jobMatch[1]
			currentLines = []
			continue
		}
		currentLines.push(line)
	}
	flush()
	return jobs
}

async function findWorkflowFiles(directory) {
	try {
		const entries = await readdir(directory, {withFileTypes: true})
		const files = []
		for (const entry of entries) {
			const target = path.join(directory, entry.name)
			if (entry.isDirectory()) files.push(...await findWorkflowFiles(target))
			else if (/\.ya?ml$/i.test(entry.name)) files.push(target)
		}
		return files
	} catch(error) {
		if (error?.code === 'ENOENT') return []
		throw error
	}
}
