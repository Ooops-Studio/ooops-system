import {TOK} from '@ooopsstudio/core/tokens'

import type {StandardResilienceOptions} from './public/standard'
import type {ManagedResilience} from './public/types'
import type {ContainerBoundary, ResilienceOptions} from './registration-types'
import {captureNativePromise} from './utils/capabilities'

type Injected = Required<Pick<StandardResilienceOptions, 'clock'>> & Partial<Omit<StandardResilienceOptions, 'clock' | 'policies'>>

export async function completeResilienceRegistration(
	container: ContainerBoundary,
	config: ResilienceOptions,
	injected: Injected
): Promise<void> {
	let resilience: ManagedResilience | undefined
	let ownedBindingObserved = false
	const observeBinding = () => {
		try {
			ownedBindingObserved = resilience !== undefined
				&& container.tryGet(TOK.Resilience) === resilience
		} catch { /* preserve the registration failure */ }
	}
	try {
		if (config.preset === 'development') {
			const {createDevelopmentResilience} = await import('./public/development')
			resilience = createDevelopmentResilience({...config.options, ...injected})
		} else if (config.preset === 'production') {
			const {createProductionResilience} = await import('./public/production')
			resilience = createProductionResilience({...config.options, ...injected})
		} else {
			const {createCustomResilience} = await import('./public/custom')
			resilience = createCustomResilience({...config.options, ...injected})
		}
		if (container.has(TOK.Resilience)) throw new Error('Resilience was registered during creation')
		let result: unknown
		try { result = container.bind(TOK.Resilience, resilience) }
		catch(error) { observeBinding(); throw error }
		observeBinding()
		const pending = captureNativePromise(result)
		if (pending) {
			try { await pending }
			catch(error) {
				try {
					const installed = container.tryGet(TOK.Resilience)
					if (installed === resilience) ownedBindingObserved = true
				} catch { /* preserve the bind failure */ }
				throw error
			}
		}
		if (container.tryGet(TOK.Resilience) !== resilience) throw new Error('Resilience container binding failed')
	} catch(error) {
		const failures: unknown[] = []
		if (ownedBindingObserved) {
			try {
				if (container.tryGet(TOK.Resilience) === resilience) {
					const pending = captureNativePromise(container.unbind(TOK.Resilience))
					if (pending) await pending
					if (container.has(TOK.Resilience)) throw new Error('Resilience registration rollback failed')
				}
			} catch(cleanupError) { failures.push(cleanupError) }
		}
		try { await resilience?.shutdown() } catch(cleanupError) { failures.push(cleanupError) }
		if (failures.length) throw new AggregateError([error, ...failures], 'Resilience registration and rollback failed')
		throw error
	}
}
