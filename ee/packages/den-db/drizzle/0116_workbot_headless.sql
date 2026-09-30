CREATE TABLE `headless_event` (
	`sequence` bigint unsigned AUTO_INCREMENT NOT NULL,
	`run_id` varchar(36) NOT NULL,
	`content` mediumtext NOT NULL,
	CONSTRAINT `headless_event_sequence` PRIMARY KEY(`sequence`)
);
--> statement-breakpoint
CREATE TABLE `headless_file` (
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`path` varchar(500) NOT NULL,
	`content` mediumtext NOT NULL,
	CONSTRAINT `headless_file_owner_path` UNIQUE(`organization_id`,`member_id`,`path`)
);
--> statement-breakpoint
CREATE TABLE `headless_run` (
	`id` varchar(36) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`surface` varchar(16) NOT NULL,
	`conversation_key` varchar(160) NOT NULL,
	`idempotency_key` varchar(160) NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`status` varchar(16) NOT NULL,
	`created_ms` bigint NOT NULL,
	`lease_owner` varchar(36),
	`lease_until` bigint,
	`content` mediumtext NOT NULL,
	CONSTRAINT `headless_run_id` PRIMARY KEY(`id`),
	CONSTRAINT `headless_run_request` UNIQUE(`organization_id`,`member_id`,`surface`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `headless_schedule` (
	`id` varchar(36) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`next_ms` bigint NOT NULL,
	`paused` int NOT NULL,
	`content` mediumtext NOT NULL,
	CONSTRAINT `headless_schedule_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `headless_event_run` ON `headless_event` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `headless_run_conversation` ON `headless_run` (`organization_id`,`member_id`,`surface`,`conversation_key`,`created_ms`);--> statement-breakpoint
CREATE INDEX `headless_run_claim` ON `headless_run` (`status`,`created_ms`);--> statement-breakpoint
CREATE INDEX `headless_run_owner_status` ON `headless_run` (`organization_id`,`member_id`,`status`);--> statement-breakpoint
CREATE INDEX `headless_schedule_owner` ON `headless_schedule` (`organization_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `headless_schedule_due` ON `headless_schedule` (`paused`,`next_ms`);