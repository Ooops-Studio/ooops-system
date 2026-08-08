import {createCustomEvents} from '../public/custom'
import type {EventsBackend} from '../types'
declare const backend: EventsBackend
export const runtime = createCustomEvents({backend, role: 'combined'})
