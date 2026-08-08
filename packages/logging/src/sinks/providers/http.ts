import {httpSink} from '../../features/transferring/http'
import type {HttpLoggingSinkConfig} from '../types'

export function createHttpLoggingSink(config: Readonly<HttpLoggingSinkConfig>) {
	return httpSink(config.url, {
		...(config.headers ? {headers: config.headers} : {}),
		...(config.requestTimeoutMs !== undefined ? {timeoutMs: config.requestTimeoutMs} : {}),
		...(config.keepalive !== undefined ? {keepalive: config.keepalive} : {})
	})
}
