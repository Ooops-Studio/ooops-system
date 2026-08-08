CREATE TABLE "audit_records" (
	"id" text PRIMARY KEY,
	"idempotency_hash" text,
	"semantic_fingerprint" text,
	"event_type" text NOT NULL,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"occurred_at" timestamptz NOT NULL,
	"created_at" timestamptz NOT NULL,
	"actor_json" jsonb NOT NULL,
	"targets_json" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"sensitivity" text NOT NULL,
	"summary" text,
	"workspace_id" text,
	"tenant_id" text,
	"stream" text,
	"correlation_json" jsonb NOT NULL,
	"context_json" jsonb NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"change_set_json" jsonb,
	"partition_key" text NOT NULL,
	"sequence" bigint NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"algorithm" text NOT NULL,
	CONSTRAINT "audit_records_sequence_valid" CHECK (sequence > 0 AND sequence <= 9007199254740991),
	CONSTRAINT "audit_records_hash_valid" CHECK (hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "audit_records_prev_hash_valid" CHECK (prev_hash IS NULL OR prev_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "audit_records_algorithm_valid" CHECK (algorithm = 'sha256-stable-json-v1'),
	CONSTRAINT "audit_records_idempotency_valid" CHECK (
		(idempotency_hash IS NULL AND semantic_fingerprint IS NULL)
		OR (idempotency_hash IS NOT NULL AND semantic_fingerprint IS NOT NULL
			AND idempotency_hash ~ '^[a-f0-9]{64}$' AND semantic_fingerprint ~ '^[a-f0-9]{64}$')
	),
	CONSTRAINT "audit_records_outcome_valid" CHECK (outcome = ANY (ARRAY['attempted', 'succeeded', 'failed', 'denied'])),
	CONSTRAINT "audit_records_sensitivity_valid" CHECK (sensitivity = ANY (ARRAY['low', 'moderate', 'high', 'restricted'])),
	CONSTRAINT "audit_records_structured_valid" CHECK (
		jsonb_typeof(actor_json) = 'object' AND jsonb_typeof(targets_json) = 'array'
		AND jsonb_array_length(targets_json) > 0 AND jsonb_typeof(correlation_json) = 'object'
		AND jsonb_typeof(context_json) = 'object' AND jsonb_typeof(metadata_json) = 'object'
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_records_partition_sequence_idx" ON "audit_records" USING btree (partition_key, sequence);
--> statement-breakpoint
CREATE INDEX "audit_records_occurred_c_idx" ON "audit_records" USING btree (occurred_at DESC, id COLLATE "C" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_records_idempotency_hash_idx" ON "audit_records" USING btree (idempotency_hash) WHERE (idempotency_hash IS NOT NULL);
--> statement-breakpoint
CREATE TABLE "audit_chain_heads" (
	"partition_key" text PRIMARY KEY,
	"last_sequence" bigint NOT NULL,
	"last_hash" text NOT NULL,
	"last_record_id" text NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "audit_chain_heads_sequence_valid" CHECK (last_sequence > 0 AND last_sequence <= 9007199254740991),
	CONSTRAINT "audit_chain_heads_hash_valid" CHECK (last_hash ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "audit_record_tombstones" (
	"record_id_hash" text PRIMARY KEY,
	"idempotency_hash" text UNIQUE,
	"semantic_fingerprint" text,
	"pruned_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "audit_record_tombstones_idem_valid" CHECK (
		(idempotency_hash IS NULL AND semantic_fingerprint IS NULL)
		OR (idempotency_hash IS NOT NULL AND semantic_fingerprint IS NOT NULL
			AND idempotency_hash ~ '^[a-f0-9]{64}$' AND semantic_fingerprint ~ '^[a-f0-9]{64}$')
	)
);
--> statement-breakpoint
CREATE TABLE "audit_schema_migrations" (
	"version" integer NOT NULL,
	"applied_at" timestamptz NOT NULL
);
--> statement-breakpoint
INSERT INTO "audit_schema_migrations" (version, applied_at) VALUES (5, now());
