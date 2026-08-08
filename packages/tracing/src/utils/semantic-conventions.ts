/**
 * @file OpenTelemetry semantic convention constants.
 * Attribute keys following OTel semantic conventions for HTTP, DB, messaging, etc.
 */
/**
 * HTTP semantic conventions.
 */
export const SEMCONV_HTTP = {
	METHOD: 'http.method',
	STATUS_CODE: 'http.status_code',
	ROUTE: 'http.route',
	TARGET: 'http.target',
	URL: 'http.url',
	USER_AGENT: 'http.user_agent',
	REQUEST_SIZE: 'http.request.size',
	RESPONSE_SIZE: 'http.response.size',
	SCHEME: 'http.scheme',
	HOST: 'http.host',
	PORT: 'http.port',
	FLAVOR: 'http.flavor',
	CLIENT_IP: 'http.client_ip'
} as const
/**
 * Database semantic conventions.
 */
export const SEMCONV_DB = {
	SYSTEM: 'db.system',
	NAME: 'db.name',
	CONNECTION_STRING: 'db.connection_string',
	STATEMENT: 'db.statement',
	OPERATION: 'db.operation',
	USER: 'db.user',
	JDBC_DRIVER_CLASSNAME: 'db.jdbc.driver_classname',
	MONGODB_COLLECTION: 'db.mongodb.collection',
	REDIS_DATABASE_INDEX: 'db.redis.database_index',
	SQL_TABLE: 'db.sql.table'
} as const
/**
 * Messaging semantic conventions.
 */
export const SEMCONV_MESSAGING = {
	SYSTEM: 'messaging.system',
	DESTINATION: 'messaging.destination',
	DESTINATION_KIND: 'messaging.destination.kind',
	PROTOCOL: 'messaging.protocol',
	PROTOCOL_VERSION: 'messaging.protocol_version',
	URL: 'messaging.url',
	MESSAGE_ID: 'messaging.message.id',
	MESSAGE_CONVERSATION_ID: 'messaging.message.conversation_id',
	MESSAGE_PAYLOAD_SIZE: 'messaging.message.payload_size_bytes',
	OPERATION: 'messaging.operation',
	CONSUMER_ID: 'messaging.consumer.id',
	RABBITMQ_ROUTING_KEY: 'messaging.rabbitmq.routing_key',
	KAFKA_MESSAGE_KEY: 'messaging.kafka.message.key',
	KAFKA_PARTITION: 'messaging.kafka.partition',
	ROCKETMQ_NAMESPACE: 'messaging.rocketmq.namespace',
	ROCKETMQ_CLIENT_GROUP: 'messaging.rocketmq.client_group'
} as const
/**
 * RPC semantic conventions.
 */
export const SEMCONV_RPC = {
	SYSTEM: 'rpc.system',
	SERVICE: 'rpc.service',
	METHOD: 'rpc.method',
	GRPC_STATUS_CODE: 'rpc.grpc.status_code',
	JSONRPC_VERSION: 'rpc.jsonrpc.version',
	JSONRPC_REQUEST_ID: 'rpc.jsonrpc.request_id',
	JSONRPC_ERROR_CODE: 'rpc.jsonrpc.error_code',
	JSONRPC_ERROR_MESSAGE: 'rpc.jsonrpc.error_message'
} as const
/**
 * Error semantic conventions.
 */
export const SEMCONV_ERROR = {
	TYPE: 'error.type',
	MESSAGE: 'error.message',
	STACK: 'error.stack'
} as const
/**
 * All semantic convention keys grouped by category.
 */
export const SEMCONV = {
	HTTP: SEMCONV_HTTP,
	DB: SEMCONV_DB,
	MESSAGING: SEMCONV_MESSAGING,
	RPC: SEMCONV_RPC,
	ERROR: SEMCONV_ERROR
} as const
