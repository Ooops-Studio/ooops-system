import {createCustomLifecycle} from '../../../src/public/custom'
import {attachNodeLifecycle} from '../../../src/public/node'

const prefix = 'OOOPS_LIFECYCLE_CHILD='
const clock = {now: Date.now}
const lifecycle = createCustomLifecycle({
	clock,
	monotonicClock: clock,
	shutdown: {drainGracePeriodMs: 0, groups: ['runtime']},
	health: {intervalMs: 0}
})

let shutdownHookCalls = 0
lifecycle.registerShutdownHook('runtime', () => { shutdownHookCalls++ })

const mode = process.env.LIFECYCLE_CHILD_MODE
if (mode === 'fatal') {
	attachNodeLifecycle(lifecycle, {
		signals: [],
		fatalErrors: {
			timeoutMs: 1_000,
			onFatalError: (error, type) => {
				console.log(prefix + JSON.stringify({event: 'fatal', message: error.message, type}))
			},
			terminate: (exitCode) => {
				console.log(prefix + JSON.stringify({event: 'terminated', exitCode, state: lifecycle.getStatus().state}))
				process.exitCode = exitCode
			}
		}
	})
	await lifecycle.start()
	void Promise.reject(new Error('token=child-secret'))
} else {
	attachNodeLifecycle(lifecycle, {signals: ['SIGTERM']})
	await lifecycle.start()
	console.log(prefix + JSON.stringify({event: 'ready'}))
	const poll = setInterval(() => {
		if (lifecycle.getStatus().state !== 'closed') return
		clearInterval(poll)
		console.log(prefix + JSON.stringify({
			event: 'closed', state: lifecycle.getStatus().state, shutdownHookCalls
		}))
	}, 5)
}
