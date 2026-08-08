export const ACTION_REFERENCES = Object.freeze({
	'actions/checkout': {
		version: 'v7',
		sha: '3d3c42e5aac5ba805825da76410c181273ba90b1'
	},
	'actions/setup-node': {
		version: 'v7',
		sha: '820762786026740c76f36085b0efc47a31fe5020'
	},
	'pnpm/action-setup': {
		version: 'v6',
		sha: 'f520eceda224fe1a4aed5a2a27a194379a409996'
	},
	'changesets/action': {
		version: 'v1',
		sha: 'a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d'
	}
})

export function applyActionPinning(workflow, mode) {
	if (mode !== 'sha') return workflow
	let result = workflow
	for (const [name, reference] of Object.entries(ACTION_REFERENCES)) {
		result = result.replaceAll(
			`uses: ${name}@${reference.version}`,
			`uses: ${name}@${reference.sha} # ${reference.version}`
		)
	}
	return result
}
