import type {CustomResilienceOptions} from './public/custom'
import type {StandardResilienceOptions} from './public/standard'

type InjectedOptions = 'clock' | 'logger' | 'errors' | 'metrics' | 'tracer' | 'performance' | 'lifecycle'
type RegisteredStandardOptions = Omit<StandardResilienceOptions, InjectedOptions>
type RegisteredCustomOptions = Omit<CustomResilienceOptions, InjectedOptions>

export type ResilienceOptions =
	| {readonly preset: 'development'; readonly options?: RegisteredStandardOptions}
	| {readonly preset: 'production'; readonly options?: RegisteredStandardOptions}
	| {readonly preset: 'custom'; readonly options: RegisteredCustomOptions}

export interface ContainerBoundary {
	has(token: symbol): boolean
	get(token: symbol): unknown
	tryGet(token: symbol): unknown
	bind(token: symbol, value: unknown): unknown
	unbind(token: symbol): unknown
}
