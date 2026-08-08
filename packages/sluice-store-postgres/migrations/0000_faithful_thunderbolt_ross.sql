CREATE TABLE "sluice_circuit" (
	"key" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"window_json" jsonb NOT NULL,
	"opened_at" bigint,
	"open_ms" integer,
	"half_open_owner" text,
	"half_open_expires_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sluice_cursor" (
	"namespace" text PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"head_hash" text DEFAULT '' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sluice_effect" (
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" bigint,
	"result_json" jsonb,
	"result_omitted" boolean DEFAULT false NOT NULL,
	"error_json" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "sluice_effect_namespace_key_pk" PRIMARY KEY("namespace","key")
);
--> statement-breakpoint
CREATE TABLE "sluice_event" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"seq" bigint NOT NULL,
	"ts" bigint NOT NULL,
	"subject_type" text NOT NULL,
	"subject_key" text NOT NULL,
	"type" text NOT NULL,
	"attempt" integer,
	"actor" text NOT NULL,
	"data_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text,
	"hash" text,
	CONSTRAINT "sluice_event_namespace_seq_key" UNIQUE("namespace","seq")
);
--> statement-breakpoint
CREATE TABLE "sluice_gate" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"action_json" jsonb NOT NULL,
	"presentation_json" jsonb,
	"requester_json" jsonb NOT NULL,
	"approvers" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"on_timeout" text DEFAULT 'reject' NOT NULL,
	"resume_context_json" jsonb,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"decided_at" bigint,
	"decided_by" text,
	"decision_reason" text,
	"token_hash" text,
	"token_nonce" text,
	"claim_owner" text,
	"claim_expires_at" bigint,
	"processed_at" bigint,
	CONSTRAINT "sluice_gate_namespace_key_key" UNIQUE("namespace","key")
);
--> statement-breakpoint
CREATE INDEX "sluice_effect_expires_at_idx" ON "sluice_effect" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sluice_effect_status_lease_idx" ON "sluice_effect" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "sluice_gate_status_expires_idx" ON "sluice_gate" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "sluice_gate_namespace_status_idx" ON "sluice_gate" USING btree ("namespace","status");--> statement-breakpoint
CREATE INDEX "sluice_gate_status_decided_idx" ON "sluice_gate" USING btree ("status","decided_at");