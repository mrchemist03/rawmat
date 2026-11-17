CREATE TABLE `notification_outbox` (
	`id` text PRIMARY KEY,
	`event` text NOT NULL,
	`dedupe_key` text NOT NULL UNIQUE,
	`occurred_at` integer NOT NULL,
	`message` text NOT NULL,
	`data` text NOT NULL,
	`recipients` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer,
	`sent_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `notification_recipients` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`phone` text NOT NULL UNIQUE,
	`active` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_rules` (
	`event` text PRIMARY KEY,
	`enabled` integer NOT NULL,
	`recipient_ids` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_pending` ON `notification_outbox` (`next_attempt_at`) WHERE "notification_outbox"."state" = 'pending';--> statement-breakpoint
CREATE INDEX `notification_history` ON `notification_outbox` (`occurred_at`,`id`);