-- apps/api's D1 schema, copied from apps/api/drizzle-d1/0001_init.sql. Keep it in step with that file.
-- `organizations` and `users` are not created here. 0007_identity_unify.sql defines both, with the columns
-- of the gateway and apps/api, so the two definitions cannot collide. Every other table is unchanged.
CREATE TABLE `personal_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `personal_access_tokens_user_id_idx` ON `personal_access_tokens` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_access_tokens_hash_unique` ON `personal_access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE TABLE `ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`algorithm` text NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ssh_keys_user_id_idx` ON `ssh_keys` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ssh_keys_fingerprint_unique` ON `ssh_keys` (`fingerprint`);
--> statement-breakpoint
CREATE TABLE `ai_agent_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`state_name` text NOT NULL,
	`step_output` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_agent_logs_run_id_created_at_idx` ON `ai_agent_logs` (`run_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `ai_agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`parent_run_id` text,
	`target_branch` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`paused_context` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_run_id`) REFERENCES `ai_agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_agent_runs_issue_id_created_at_idx` ON `ai_agent_runs` (`issue_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ai_agent_runs_parent_run_id_idx` ON `ai_agent_runs` (`parent_run_id`);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`stream_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`source_id` text NOT NULL,
	`payload` text NOT NULL,
	`signature` text NOT NULL,
	`key_id` text NOT NULL,
	`record_hash` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_logs_stream_sequence_unique` ON `audit_logs` (`stream_id`,`sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_logs_kind_source_unique` ON `audit_logs` (`kind`,`source_id`);
--> statement-breakpoint
CREATE INDEX `audit_logs_recorded_at_idx` ON `audit_logs` (`recorded_at`);
--> statement-breakpoint
CREATE TABLE `daily_usage_logs` (
	`id` integer PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`date` text NOT NULL,
	`total_prompt_tokens` integer DEFAULT 0 NOT NULL,
	`total_completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_cicd_minutes` integer DEFAULT 0 NOT NULL,
	`agent_spawn_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "daily_usage_logs_counters_nonnegative" CHECK("daily_usage_logs"."total_prompt_tokens" >= 0 AND "daily_usage_logs"."total_completion_tokens" >= 0 AND "daily_usage_logs"."total_cicd_minutes" >= 0 AND "daily_usage_logs"."agent_spawn_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_usage_logs_org_date_unique` ON `daily_usage_logs` (`org_id`,`date`);
--> statement-breakpoint
CREATE TABLE `debate_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`task_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`outcome` text NOT NULL,
	`prompt_tokens` integer NOT NULL,
	`completion_tokens` integer NOT NULL,
	`payload` text NOT NULL,
	`signature` text NOT NULL,
	`signature_algorithm` text NOT NULL,
	`key_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `debate_audit_logs_flow_id_idx` ON `debate_audit_logs` (`flow_id`);
--> statement-breakpoint
CREATE TABLE `discussion_events` (
	`id` text PRIMARY KEY NOT NULL,
	`discussion_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`lock_reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `discussion_events_discussion_id_created_at_idx` ON `discussion_events` (`discussion_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `discussion_labels` (
	`discussion_id` text NOT NULL,
	`label` text NOT NULL,
	PRIMARY KEY(`discussion_id`, `label`),
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `discussion_labels_label_idx` ON `discussion_labels` (`label`);
--> statement-breakpoint
CREATE TABLE `discussion_locks` (
	`discussion_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`locked_by_id` text NOT NULL,
	`locked_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`locked_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `discussion_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`discussion_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`is_answer` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `discussion_replies_discussion_id_created_at_idx` ON `discussion_replies` (`discussion_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `discussion_replies_one_answer_idx` ON `discussion_replies` (`discussion_id`) WHERE "discussion_replies"."is_answer" = true;
--> statement-breakpoint
CREATE TABLE `discussion_subscriptions` (
	`discussion_id` text NOT NULL,
	`user_id` text NOT NULL,
	`subscribed` integer NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`discussion_id`, `user_id`),
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `discussion_votes` (
	`discussion_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`discussion_id`, `user_id`),
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `discussions` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`author_id` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `discussions_repo_id_created_at_idx` ON `discussions` (`repo_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `discussions_author_id_idx` ON `discussions` (`author_id`);
--> statement-breakpoint
CREATE TABLE `flow_task_runs` (
	`flow_id` text NOT NULL,
	`task_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`queue` text NOT NULL,
	`memory_hits` text NOT NULL,
	`recorded_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`flow_id`, `task_id`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `flow_task_runs_repository_flow_idx` ON `flow_task_runs` (`repository_id`,`flow_id`);
--> statement-breakpoint
CREATE TABLE `issue_labels` (
	`issue_id` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`issue_id`, `label`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_labels_label_idx` ON `issue_labels` (`label`);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`author_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`closed_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `issues_repo_id_idx` ON `issues` (`repo_id`);
--> statement-breakpoint
CREATE INDEX `issues_author_id_idx` ON `issues` (`author_id`);
--> statement-breakpoint
CREATE TABLE `mcp_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`server_url` text NOT NULL,
	`api_key` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_connections_org_server_url_unique` ON `mcp_connections` (`org_id`,`server_url`);
--> statement-breakpoint
CREATE TABLE `organization_billing` (
	`org_id` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_subscription_id` text,
	`plan` text DEFAULT 'free' NOT NULL,
	`subscription_status` text,
	`seats` integer DEFAULT 0 NOT NULL,
	`stripe_event_created` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_billing_seats_nonnegative" CHECK("organization_billing"."seats" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_billing_customer_unique` ON `organization_billing` (`stripe_customer_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_billing_subscription_unique` ON `organization_billing` (`stripe_subscription_id`);
--> statement-breakpoint
CREATE TABLE `organization_members` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`organization_id`, `user_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_members_user_id_idx` ON `organization_members` (`user_id`);
--> statement-breakpoint
CREATE TABLE `organization_usage_credits` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`stripe_event_id` text NOT NULL,
	`tokens` integer NOT NULL,
	`period_start` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_usage_credits_tokens_nonnegative" CHECK("organization_usage_credits"."tokens" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_usage_credits_stripe_event_id_unique` ON `organization_usage_credits` (`stripe_event_id`);
--> statement-breakpoint
CREATE INDEX `organization_usage_credits_org_period_idx` ON `organization_usage_credits` (`org_id`,`period_start`);
--> statement-breakpoint
CREATE TABLE `organization_usage_limits` (
	`org_id` text PRIMARY KEY NOT NULL,
	`monthly_token_limit` integer,
	`monthly_cicd_minutes_limit` integer,
	`monthly_agent_spawn_limit` integer,
	`current_billing_cycle_start` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`is_throttled` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_usage_limits_token_limit_nonnegative" CHECK("organization_usage_limits"."monthly_token_limit" IS NULL OR "organization_usage_limits"."monthly_token_limit" >= 0),
	CONSTRAINT "organization_usage_limits_cicd_limit_nonnegative" CHECK("organization_usage_limits"."monthly_cicd_minutes_limit" IS NULL OR "organization_usage_limits"."monthly_cicd_minutes_limit" >= 0),
	CONSTRAINT "organization_usage_limits_agent_spawn_limit_nonnegative" CHECK("organization_usage_limits"."monthly_agent_spawn_limit" IS NULL OR "organization_usage_limits"."monthly_agent_spawn_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`logs` text DEFAULT '' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`job_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_runs_job_id_unique` ON `pipeline_runs` (`job_id`);
--> statement-breakpoint
CREATE INDEX `pipeline_runs_repo_id_idx` ON `pipeline_runs` (`repo_id`);
--> statement-breakpoint
CREATE TABLE `project_views` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`layout` text NOT NULL,
	`filter` text DEFAULT '' NOT NULL,
	`group_by` text DEFAULT 'none' NOT NULL,
	`sort_by` text DEFAULT 'manual' NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_views_layout_check" CHECK(layout in ('table', 'board', 'roadmap')),
	CONSTRAINT "project_views_group_by_check" CHECK(group_by in ('none', 'status', 'assignee', 'priority')),
	CONSTRAINT "project_views_sort_by_check" CHECK(sort_by in ('manual', 'title')),
	CONSTRAINT "project_views_name_length_check" CHECK(length(name) between 1 and 50),
	CONSTRAINT "project_views_filter_length_check" CHECK(length(filter) <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_views_project_position_unique` ON `project_views` (`project_id`,`position`);
--> statement-breakpoint
CREATE TABLE `project_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_columns_project_position_unique` ON `project_columns` (`project_id`,`position`);
--> statement-breakpoint
CREATE TABLE `project_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`column_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`issue_id` text,
	`pull_request_id` text,
	`draft_title` text,
	`start_date` text,
	`target_date` text,
	`iteration` text,
	`priority` text,
	`draft_body` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`) REFERENCES `project_columns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_items_kind_reference_check" CHECK((
        (kind = 'ISSUE' and issue_id is not null and pull_request_id is null and draft_title is null)
        or (kind = 'PULL_REQUEST' and pull_request_id is not null and issue_id is null and draft_title is null)
        or (kind = 'DRAFT' and draft_title is not null and issue_id is null and pull_request_id is null)
      )),
	CONSTRAINT "project_items_schedule_order_check" CHECK((start_date is null or target_date is null or start_date <= target_date)),
	CONSTRAINT "project_items_iteration_length_check" CHECK((iteration is null or length(iteration) between 1 and 50)),
	CONSTRAINT "project_items_priority_check" CHECK((priority is null or priority in ('P1', 'P2', 'P3'))),
	CONSTRAINT "project_items_draft_body_check" CHECK((draft_body is null or (kind = 'DRAFT' and length(draft_body) <= 100000)))
);
--> statement-breakpoint
CREATE INDEX `project_items_column_position_idx` ON `project_items` (`column_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_items_project_issue_unique` ON `project_items` (`project_id`,`issue_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_items_project_pull_request_unique` ON `project_items` (`project_id`,`pull_request_id`);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repo_number_unique` ON `projects` (`repo_id`,`number`);
--> statement-breakpoint
CREATE TABLE `pull_request_auto_merges` (
	`pull_request_id` text PRIMARY KEY NOT NULL,
	`enabled_by` text NOT NULL,
	`enabled_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enabled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `pull_request_comment_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `pull_request_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `pull_request_comment_replies_comment_id_idx` ON `pull_request_comment_replies` (`comment_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `pull_request_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`author_id` text,
	`review_id` text,
	`path` text,
	`side` text DEFAULT 'RIGHT' NOT NULL,
	`line` integer,
	`body` text NOT NULL,
	`critique` text,
	`dedupe_key` text NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`fix_status` text,
	`fix_commit_sha` text,
	`fix_attempt` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`review_id`) REFERENCES `pull_request_reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "pull_request_comments_location_check" CHECK(("pull_request_comments"."path" is null) = ("pull_request_comments"."line" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_request_comments_dedupe_key_unique` ON `pull_request_comments` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `pull_request_comments_pull_request_id_idx` ON `pull_request_comments` (`pull_request_id`);
--> statement-breakpoint
CREATE INDEX `pull_request_comments_review_id_idx` ON `pull_request_comments` (`review_id`);
--> statement-breakpoint
CREATE TABLE `pull_request_labels` (
	`pull_request_id` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`pull_request_id`, `label`),
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_request_labels_label_idx` ON `pull_request_labels` (`label`);
--> statement-breakpoint
CREATE TABLE `pull_request_repair_outcomes` (
	`pull_request_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`commit_sha` text,
	`summary` text NOT NULL,
	`recorded_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pull_request_repair_outcomes_commit_sha_pushed" CHECK(("pull_request_repair_outcomes"."status" = 'pushed') = ("pull_request_repair_outcomes"."commit_sha" is not null))
);
--> statement-breakpoint
CREATE TABLE `pull_request_review_requests` (
	`pull_request_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`pull_request_id`, `reviewer_id`),
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_request_review_requests_reviewer_id_idx` ON `pull_request_review_requests` (`reviewer_id`);
--> statement-breakpoint
CREATE TABLE `pull_request_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`state` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_request_reviews_pull_request_id_idx` ON `pull_request_reviews` (`pull_request_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_request_reviews_one_pending_idx` ON `pull_request_reviews` (`pull_request_id`,`reviewer_id`) WHERE "pull_request_reviews"."state" = 'PENDING';
--> statement-breakpoint
CREATE TABLE `pull_request_security_scans` (
	`pull_request_id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`status` text NOT NULL,
	`event_id` text,
	`message` text,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_request_security_scans_repository_id_idx` ON `pull_request_security_scans` (`repository_id`);
--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`author_id` text NOT NULL,
	`head_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
	`preview_url` text,
	`preview_status` text DEFAULT 'idle' NOT NULL,
	`ai_review_status` text DEFAULT 'idle' NOT NULL,
	`ai_review_token` text,
	`merged_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "pull_requests_preview_status_check" CHECK("pull_requests"."preview_status" in ('idle', 'starting', 'ready', 'failed')),
	CONSTRAINT "pull_requests_ai_review_status_check" CHECK("pull_requests"."ai_review_status" in ('idle', 'running', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `pull_requests_repo_id_idx` ON `pull_requests` (`repo_id`);
--> statement-breakpoint
CREATE INDEX `pull_requests_author_id_idx` ON `pull_requests` (`author_id`);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`organization_id` text,
	`name` text NOT NULL,
	`description` text,
	`is_private` integer DEFAULT true NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_owner_name_lower_unique` ON `repositories` (`owner_id`,lower("name"));
--> statement-breakpoint
CREATE INDEX `repositories_organization_id_idx` ON `repositories` (`organization_id`);
--> statement-breakpoint
CREATE TABLE `repository_access` (
	`user_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `repo_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `repository_access_repo_id_idx` ON `repository_access` (`repo_id`);
--> statement-breakpoint
CREATE TABLE `repository_secrets` (
	`repo_id` text NOT NULL,
	`name` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`repo_id`, `name`),
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `repository_teams` (
	`repository_id` text NOT NULL,
	`team_id` text NOT NULL,
	`permission` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`repository_id`, `team_id`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `repository_teams_team_id_idx` ON `repository_teams` (`team_id`);
--> statement-breakpoint
CREATE TABLE `security_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`pull_request_id` text,
	`alert_type` text NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`file_path` text NOT NULL,
	`line_number` integer,
	`description` text NOT NULL,
	`ai_remediation_suggestion` text,
	`dismissal_reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `security_alerts_repository_id_status_idx` ON `security_alerts` (`repository_id`,`status`);
--> statement-breakpoint
CREATE INDEX `security_alerts_repository_id_alert_type_idx` ON `security_alerts` (`repository_id`,`alert_type`);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_alerts_open_location_uidx` ON `security_alerts` (`repository_id`,`file_path`,case when "line_number" is null then -1 else "line_number" end,`alert_type`) WHERE status = 'open';
--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_members_user_id_idx` ON `team_members` (`user_id`);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_organization_slug_lower_unique` ON `teams` (`organization_id`,lower("slug"));
--> statement-breakpoint
CREATE TABLE `telemetry_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`applied_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`discussion_id` text NOT NULL,
	`reply_id` text,
	`mentioned_user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reply_id`) REFERENCES `discussion_replies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mentioned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_mentions_body_unique_idx` ON `user_mentions` (`discussion_id`,`mentioned_user_id`) WHERE "user_mentions"."reply_id" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX `user_mentions_reply_unique_idx` ON `user_mentions` (`reply_id`,`mentioned_user_id`) WHERE "user_mentions"."reply_id" is not null;
--> statement-breakpoint
CREATE INDEX `user_mentions_mentioned_user_id_discussion_id_idx` ON `user_mentions` (`mentioned_user_id`,`discussion_id`);
--> statement-breakpoint
CREATE TABLE `user_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`response_code` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `user_webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_webhook_deliveries_webhook_event_unique` ON `user_webhook_deliveries` (`webhook_id`,`event_id`);
--> statement-breakpoint
CREATE TABLE `user_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`url` text NOT NULL,
	`secret_ciphertext` text,
	`events` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_webhooks_user_id_idx` ON `user_webhooks` (`user_id`);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`response_code` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_webhook_event_unique` ON `webhook_deliveries` (`webhook_id`,`event_id`);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_event_id_idx` ON `webhook_deliveries` (`event_id`);
--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`url` text NOT NULL,
	`secret` text,
	`events` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhooks_repo_id_idx` ON `webhooks` (`repo_id`);
--> statement-breakpoint
CREATE TABLE `wiki_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`parent_page_id` text,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`last_commit_hash` text,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_page_id`,`repository_id`) REFERENCES `wiki_pages`(`id`,`repository_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "wiki_pages_parent_not_self_check" CHECK("wiki_pages"."parent_page_id" is null or "wiki_pages"."parent_page_id" <> "wiki_pages"."id"),
	CONSTRAINT "wiki_pages_title_length_check" CHECK(length("wiki_pages"."title") between 1 and 200 and length(trim("wiki_pages"."title")) >= 1),
	CONSTRAINT "wiki_pages_content_length_check" CHECK(length("wiki_pages"."content") <= 1000000)
);
--> statement-breakpoint
CREATE INDEX `wiki_pages_repository_id_idx` ON `wiki_pages` (`repository_id`);
--> statement-breakpoint
CREATE INDEX `wiki_pages_parent_page_id_idx` ON `wiki_pages` (`parent_page_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_pages_repo_parent_slug_active_uidx` ON `wiki_pages` (`repository_id`,case when "parent_page_id" is null then '00000000-0000-0000-0000-000000000000' else "parent_page_id" end,lower("slug")) WHERE "wiki_pages"."deleted_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_pages_id_repository_id_unique` ON `wiki_pages` (`id`,`repository_id`);
--> statement-breakpoint
CREATE TABLE `wiki_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`page_id` text NOT NULL,
	`content` text NOT NULL,
	`commit_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `wiki_pages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "wiki_revisions_content_length_check" CHECK(length("wiki_revisions"."content") <= 1000000)
);
--> statement-breakpoint
CREATE INDEX `wiki_revisions_page_id_created_at_idx` ON `wiki_revisions` (`page_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `workflow_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`log_url` text,
	`exit_code` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_jobs_run_id_idx` ON `workflow_jobs` (`run_id`);
--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`branch` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`triggered_by` text NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`triggered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_repository_created_at_idx` ON `workflow_runs` (`repository_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow_id_idx` ON `workflow_runs` (`workflow_id`);
--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`name` text NOT NULL,
	`file_path` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_repository_file_path_unique` ON `workflows` (`repository_id`,`file_path`);
