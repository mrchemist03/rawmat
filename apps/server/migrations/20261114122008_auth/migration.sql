CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY,
	`actor_id` text,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	CONSTRAINT `fk_audit_log_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `branches` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`city` text NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY,
	`account_key` text NOT NULL,
	`address_key` text NOT NULL,
	`attempted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`last_active_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `turnstile_redemptions` (
	`token_hash` text PRIMARY KEY,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`login_name` text NOT NULL UNIQUE,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`branch_id` text,
	`active` integer DEFAULT true NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	CONSTRAINT `fk_users_branch_id_branches_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`),
	CONSTRAINT "users_role_valid" CHECK("role" in ('user', 'admin', 'superuser'))
);
--> statement-breakpoint
CREATE INDEX `audit_log_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `login_attempts_account_window` ON `login_attempts` (`account_key`,`attempted_at`);--> statement-breakpoint
CREATE INDEX `login_attempts_address_window` ON `login_attempts` (`address_key`,`attempted_at`);--> statement-breakpoint
CREATE INDEX `login_attempts_time` ON `login_attempts` (`attempted_at`);--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `turnstile_redemptions_expiry` ON `turnstile_redemptions` (`expires_at`);
--> statement-breakpoint
CREATE TRIGGER revoke_user_sessions
AFTER UPDATE OF active, role, password_hash ON users
WHEN OLD.active <> NEW.active OR OLD.role <> NEW.role OR OLD.password_hash <> NEW.password_hash
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.id;
END;
