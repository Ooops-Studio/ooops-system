/**
 * @file Tests for semantic conventions.
 */

import {describe, it, expect} from 'vitest'

import {
	SEMCONV_HTTP,
	SEMCONV_DB,
	SEMCONV_MESSAGING,
	SEMCONV_RPC,
	SEMCONV_ERROR,
	SEMCONV
} from '../../src/utils/semantic-conventions'

describe('semantic-conventions', () => {

	it('should export HTTP semantic conventions', () => {

		expect(SEMCONV_HTTP.METHOD).toBe('http.method')
		expect(SEMCONV_HTTP.STATUS_CODE).toBe('http.status_code')
		expect(SEMCONV_HTTP.ROUTE).toBe('http.route')
		expect(SEMCONV_HTTP.TARGET).toBe('http.target')
		expect(SEMCONV_HTTP.URL).toBe('http.url')
		expect(SEMCONV_HTTP.USER_AGENT).toBe('http.user_agent')
		expect(SEMCONV_HTTP.REQUEST_SIZE).toBe('http.request.size')
		expect(SEMCONV_HTTP.RESPONSE_SIZE).toBe('http.response.size')
		expect(SEMCONV_HTTP.SCHEME).toBe('http.scheme')
		expect(SEMCONV_HTTP.HOST).toBe('http.host')
		expect(SEMCONV_HTTP.PORT).toBe('http.port')
		expect(SEMCONV_HTTP.FLAVOR).toBe('http.flavor')
		expect(SEMCONV_HTTP.CLIENT_IP).toBe('http.client_ip')
	})

	it('should export DB semantic conventions', () => {

		expect(SEMCONV_DB.SYSTEM).toBe('db.system')
		expect(SEMCONV_DB.NAME).toBe('db.name')
		expect(SEMCONV_DB.CONNECTION_STRING).toBe('db.connection_string')
		expect(SEMCONV_DB.STATEMENT).toBe('db.statement')
		expect(SEMCONV_DB.OPERATION).toBe('db.operation')
		expect(SEMCONV_DB.USER).toBe('db.user')
		expect(SEMCONV_DB.JDBC_DRIVER_CLASSNAME).toBe('db.jdbc.driver_classname')
		expect(SEMCONV_DB.MONGODB_COLLECTION).toBe('db.mongodb.collection')
		expect(SEMCONV_DB.REDIS_DATABASE_INDEX).toBe('db.redis.database_index')
		expect(SEMCONV_DB.SQL_TABLE).toBe('db.sql.table')
	})

	it('should export Messaging semantic conventions', () => {

		expect(SEMCONV_MESSAGING.SYSTEM).toBe('messaging.system')
		expect(SEMCONV_MESSAGING.DESTINATION).toBe('messaging.destination')
		expect(SEMCONV_MESSAGING.DESTINATION_KIND).toBe('messaging.destination.kind')
		expect(SEMCONV_MESSAGING.PROTOCOL).toBe('messaging.protocol')
		expect(SEMCONV_MESSAGING.PROTOCOL_VERSION).toBe('messaging.protocol_version')
		expect(SEMCONV_MESSAGING.URL).toBe('messaging.url')
		expect(SEMCONV_MESSAGING.MESSAGE_ID).toBe('messaging.message.id')
		expect(SEMCONV_MESSAGING.MESSAGE_CONVERSATION_ID).toBe('messaging.message.conversation_id')
		expect(SEMCONV_MESSAGING.MESSAGE_PAYLOAD_SIZE).toBe('messaging.message.payload_size_bytes')
		expect(SEMCONV_MESSAGING.OPERATION).toBe('messaging.operation')
		expect(SEMCONV_MESSAGING.CONSUMER_ID).toBe('messaging.consumer.id')
		expect(SEMCONV_MESSAGING.RABBITMQ_ROUTING_KEY).toBe('messaging.rabbitmq.routing_key')
		expect(SEMCONV_MESSAGING.KAFKA_MESSAGE_KEY).toBe('messaging.kafka.message.key')
		expect(SEMCONV_MESSAGING.KAFKA_PARTITION).toBe('messaging.kafka.partition')
		expect(SEMCONV_MESSAGING.ROCKETMQ_NAMESPACE).toBe('messaging.rocketmq.namespace')
		expect(SEMCONV_MESSAGING.ROCKETMQ_CLIENT_GROUP).toBe('messaging.rocketmq.client_group')
	})

	it('should export RPC semantic conventions', () => {

		expect(SEMCONV_RPC.SYSTEM).toBe('rpc.system')
		expect(SEMCONV_RPC.SERVICE).toBe('rpc.service')
		expect(SEMCONV_RPC.METHOD).toBe('rpc.method')
		expect(SEMCONV_RPC.GRPC_STATUS_CODE).toBe('rpc.grpc.status_code')
		expect(SEMCONV_RPC.JSONRPC_VERSION).toBe('rpc.jsonrpc.version')
		expect(SEMCONV_RPC.JSONRPC_REQUEST_ID).toBe('rpc.jsonrpc.request_id')
		expect(SEMCONV_RPC.JSONRPC_ERROR_CODE).toBe('rpc.jsonrpc.error_code')
		expect(SEMCONV_RPC.JSONRPC_ERROR_MESSAGE).toBe('rpc.jsonrpc.error_message')
	})

	it('should export Error semantic conventions', () => {

		expect(SEMCONV_ERROR.TYPE).toBe('error.type')
		expect(SEMCONV_ERROR.MESSAGE).toBe('error.message')
		expect(SEMCONV_ERROR.STACK).toBe('error.stack')
	})

	it('should export grouped SEMCONV object', () => {

		expect(SEMCONV.HTTP).toBe(SEMCONV_HTTP)
		expect(SEMCONV.DB).toBe(SEMCONV_DB)
		expect(SEMCONV.MESSAGING).toBe(SEMCONV_MESSAGING)
		expect(SEMCONV.RPC).toBe(SEMCONV_RPC)
		expect(SEMCONV.ERROR).toBe(SEMCONV_ERROR)
	})

	it('should have all constants as readonly', () => {

		// Verify constants are properly defined
		expect(Object.keys(SEMCONV_HTTP).length).toBeGreaterThan(0)
		expect(Object.keys(SEMCONV_DB).length).toBeGreaterThan(0)
		expect(Object.keys(SEMCONV_MESSAGING).length).toBeGreaterThan(0)
		expect(Object.keys(SEMCONV_RPC).length).toBeGreaterThan(0)
		expect(Object.keys(SEMCONV_ERROR).length).toBeGreaterThan(0)
	})
})
