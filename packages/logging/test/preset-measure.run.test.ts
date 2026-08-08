import {writeFile} from 'node:fs/promises'
import {performance} from 'node:perf_hooks'

import {expect, it} from 'vitest'

type Preset = 'development' | 'production'
type Scenario = 'startup' | 'first-log-flush'

function getOptionalEnv(name: string): string | undefined {
	return process.env[name]
}

function getEnv(name: string): string {
	const value = getOptionalEnv(name)
	if (!value) {
		throw new Error(`Missing required env: ${name}`)
	}
	return value
}

function parsePreset(value: string): Preset {
	if (value === 'development' || value === 'production') {
		return value
	}
	throw new Error(`Unknown preset: ${value}`)
}

function parseScenario(value: string): Scenario {
	if (value === 'startup' || value === 'first-log-flush') {
		return value
	}
	throw new Error(`Unknown scenario: ${value}`)
}

function suppressConsole() {
	const stdoutWrite = process.stdout.write.bind(process.stdout)
	const stderrWrite = process.stderr.write.bind(process.stderr)

	process.stdout.write = (() => true) as typeof process.stdout.write
	process.stderr.write = (() => true) as typeof process.stderr.write

	return () => {
		process.stdout.write = stdoutWrite as typeof process.stdout.write
		process.stderr.write = stderrWrite as typeof process.stderr.write
	}
}

async function createLogger(preset: Preset) {
	if (preset === 'development') {
		const {createDevelopmentLogging} = await import('../src/public/development')
		return await createDevelopmentLogging({
			selfMetrics: false
		})
	}

	const {createProductionLogging} = await import('../src/public/production')
	return await createProductionLogging({
		selfMetrics: false,
		urlConfig: {},
		context: {attributes: {service: 'bench'}}
	})
}

const shouldRunMeasurement =
	Boolean(getOptionalEnv('PRESET_MEASURE_PRESET')) &&
	Boolean(getOptionalEnv('PRESET_MEASURE_SCENARIO')) &&
	Boolean(getOptionalEnv('PRESET_MEASURE_OUT'))

const measureIt = shouldRunMeasurement ? it : it.skip

measureIt('records preset measurement to a file', async() => {
	const preset = parsePreset(getEnv('PRESET_MEASURE_PRESET'))
	const scenario = parseScenario(getEnv('PRESET_MEASURE_SCENARIO'))
	const outputFile = getEnv('PRESET_MEASURE_OUT')
	const restoreConsole = suppressConsole()
	const startedAt = performance.now()

	try {
		const logger = await createLogger(preset)
		const createdAt = performance.now()

		if (scenario === 'first-log-flush') {
			logger.info('benchmark message')
			await logger.flush()
		}

		const finishedAt = performance.now()
		await logger.shutdown()

		const payload = {
			preset,
			scenario,
			createMs: createdAt - startedAt,
			scenarioMs: scenario === 'startup' ? createdAt - startedAt : finishedAt - createdAt,
			totalMs: finishedAt - startedAt
		}

		restoreConsole()
		await writeFile(outputFile, `${JSON.stringify(payload)}\n`, 'utf8')
		expect(payload.scenarioMs).toBeGreaterThanOrEqual(0)
	} finally {
		restoreConsole()
	}
}, 30_000)
