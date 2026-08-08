import type {FaroBrowserClient} from './faro-browser-types'

let initializedKey: string | undefined
let initializedClient: FaroBrowserClient | undefined

export const getFaroBrowserState = (): Readonly<{
	key: string | undefined
	client: FaroBrowserClient | undefined
}> => ({
	key: initializedKey,
	client: initializedClient
})

export const setFaroBrowserState = (key: string, client: FaroBrowserClient): void => {
	initializedKey = key
	initializedClient = client
}

/** Test-only source helper; not exposed by a package entrypoint. */
export const resetFaroBrowserState = (): void => {
	initializedKey = undefined
	initializedClient = undefined
}
