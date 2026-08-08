import {createProductionEvents} from '../public/production'
import type {EventsBackend} from '../types'
declare const backend: EventsBackend
export const runtime = createProductionEvents({backend, role: 'worker'})
