import type {ErrorHandlerOptions, ErrorsHandlerPort} from '../types/error-handler'

import type {ProductionErrorHandlerOptions} from './production'

type Assert<T extends true> = T
type Has<T, Key extends PropertyKey> = Key extends keyof T ? true : false
type Not<Value extends boolean> = Value extends true ? false : true

type _HandlerHasHandle = Assert<Has<ErrorsHandlerPort, 'handle'>>
type _HandlerHasNormalize = Assert<Has<ErrorsHandlerPort, 'normalize'>>
type _HandlerHasClassify = Assert<Has<ErrorsHandlerPort, 'classify'>>
type _HandlerHasFlush = Assert<Has<ErrorsHandlerPort, 'flush'>>
type _HandlerHasShutdown = Assert<Has<ErrorsHandlerPort, 'shutdown'>>
type _HandlerRemovedDestroy = Assert<Not<Has<ErrorsHandlerPort, 'destroy'>>>

type _OptionsKeepReport = Assert<Has<ErrorHandlerOptions, 'report'>>
type _OptionsKeepRegistry = Assert<Has<ErrorHandlerOptions, 'classificationRegistry'>>
type _OptionsKeepObserve = Assert<Has<ErrorHandlerOptions, 'observe'>>
type _OptionsRemovedRuntime = Assert<Not<Has<ErrorHandlerOptions, 'reportRuntime'>>>
type _OptionsRemovedCacheObject = Assert<Not<Has<ErrorHandlerOptions, 'errorDeduplicationCache'>>>

type _ProductionHasRegistry = Assert<Has<ProductionErrorHandlerOptions, 'classificationRegistry'>>
type _ProductionHasObserve = Assert<Has<ProductionErrorHandlerOptions, 'observe'>>
type _ProductionHasSource = Assert<Has<ProductionErrorHandlerOptions, 'defaultSource'>>
