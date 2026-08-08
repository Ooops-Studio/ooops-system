import {isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

export interface PostgresEventMigration {readonly version: number; readonly sql: string}

export function createPostgresEventMigrations(prefix: string = 'events'): readonly PostgresEventMigration[] {
	if (isolateUnexpectedThenable(prefix) || typeof prefix !== 'string' || !/^[a-z_][a-z0-9_]{0,55}$/u.test(prefix)) {
		throw new Error('EVENTS_TABLE_PREFIX_INVALID')
	}
	return Object.freeze([{version: 1, sql: `
CREATE TABLE IF NOT EXISTS ${prefix}_outbox (
  event_id text PRIMARY KEY, envelope_json jsonb NOT NULL, status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0, last_error text, next_attempt_at timestamptz,
  processing_started_at timestamptz, processing_by text, dispatched_at timestamptz,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  attempts_log_json jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS ${prefix}_outbox_due_idx ON ${prefix}_outbox(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS ${prefix}_outbox_processing_idx ON ${prefix}_outbox(status,processing_started_at);
CREATE TABLE IF NOT EXISTS ${prefix}_inbox (
  consumer text NOT NULL, event_id text NOT NULL, record_json jsonb NOT NULL,
  PRIMARY KEY(consumer,event_id)
);`}])
}
