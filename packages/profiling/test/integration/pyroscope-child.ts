import * as sdkModule from '@pyroscope/nodejs'

import {createPyroscopeProfilingWithSdk} from '../../src/pyroscope-provider'

const endpoint = process.env.PYROSCOPE_TEST_ENDPOINT
if (!endpoint) throw new Error('PYROSCOPE_TEST_ENDPOINT is required')
const sdk = (sdkModule as {default?: unknown}).default ?? sdkModule
const provider = createPyroscopeProfilingWithSdk({
	applicationName: 'ooops-suite-integration-worker',
	connection: {mode: 'grafana-cloud', serverAddress: endpoint, credentials: {username: 'profiles-user', password: 'profiles-token'}},
	resource: {serviceName: 'ooops-suite', serviceVersion: 'integration', deploymentEnvironment: 'test'},
	tags: {team: 'studio'}
}, async() => ({default: sdk as never}))

await provider.start()
const until = Date.now() + 150
let value = 0
while (Date.now() < until) value += Math.sqrt(value + 1)
await provider.shutdown()
if (provider.getStatus().state !== 'closed' || !Number.isFinite(value)) throw new Error('provider did not close cleanly')
