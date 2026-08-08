export {JOBS_LEGACY_MIGRATION_VERSION, JOBS_SCHEMA_VERSION} from './sql-version'

export const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS ooops_jobs_schema_migrations (
  namespace text NOT NULL, version text NOT NULL, applied_at bigint NOT NULL,
  PRIMARY KEY(namespace, version)
);
CREATE TABLE IF NOT EXISTS ooops_jobs_runs (
  namespace text NOT NULL, id text NOT NULL, task text NOT NULL, queue text NOT NULL,
  status text NOT NULL, run_at bigint NOT NULL, priority integer NOT NULL,
  schedule_id text, lease_token text, lease_expires_at bigint, terminal_expires_at bigint,
  created_at bigint NOT NULL, updated_at bigint NOT NULL, started_at bigint,
  completed_at bigint, terminal_at bigint,
  data jsonb NOT NULL, PRIMARY KEY(namespace, id)
);
CREATE TABLE IF NOT EXISTS ooops_jobs_schedules (
  namespace text NOT NULL, id text NOT NULL, task text NOT NULL, queue text,
  enabled boolean NOT NULL, next_run_at bigint, data jsonb NOT NULL,
  PRIMARY KEY(namespace, id)
);
CREATE TABLE IF NOT EXISTS ooops_jobs_dead_letters (
  namespace text NOT NULL, id text NOT NULL, run_id text NOT NULL, queue text NOT NULL,
  task text NOT NULL, failed_at bigint NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(namespace, id)
);
CREATE TABLE IF NOT EXISTS ooops_jobs_idempotency (
  namespace text NOT NULL, key text NOT NULL, run_id text NOT NULL,
  checksum text NOT NULL, expires_at bigint NOT NULL, PRIMARY KEY(namespace, key)
);
CREATE TABLE IF NOT EXISTS ooops_jobs_paused_queues (
  namespace text NOT NULL, queue text NOT NULL, PRIMARY KEY(namespace, queue)
);
CREATE INDEX IF NOT EXISTS ooops_jobs_runs_due_idx ON ooops_jobs_runs(namespace, status, run_at, priority DESC);
CREATE INDEX IF NOT EXISTS ooops_jobs_runs_queue_idx ON ooops_jobs_runs(namespace, queue, status, run_at);
CREATE INDEX IF NOT EXISTS ooops_jobs_runs_task_idx ON ooops_jobs_runs(namespace, task, status);
CREATE INDEX IF NOT EXISTS ooops_jobs_runs_schedule_idx ON ooops_jobs_runs(namespace, schedule_id, status);
CREATE INDEX IF NOT EXISTS ooops_jobs_runs_lease_idx ON ooops_jobs_runs(namespace, lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS ooops_jobs_runs_terminal_idx ON ooops_jobs_runs(namespace, terminal_expires_at) WHERE terminal_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ooops_jobs_schedules_due_idx ON ooops_jobs_schedules(namespace, enabled, next_run_at);
CREATE INDEX IF NOT EXISTS ooops_jobs_idempotency_expiry_idx ON ooops_jobs_idempotency(namespace, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS ooops_jobs_dead_letters_run_idx ON ooops_jobs_dead_letters(namespace, run_id);
`
