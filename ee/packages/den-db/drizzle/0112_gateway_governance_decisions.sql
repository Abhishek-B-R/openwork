CREATE TABLE `gateway_governance_admission` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`contribution_digest` char(64) NOT NULL,
	`policy_set_revision` int NOT NULL,
	`decision_id` varchar(128) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `gateway_governance_admission_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_governance_admission_scope` UNIQUE(`organization_id`,`org_membership_id`,`contribution_digest`)
);
--> statement-breakpoint
CREATE TABLE `gateway_governance_decision` (
	`id` varchar(64) NOT NULL,
	`decision_id` varchar(128) NOT NULL,
	`request_id` varchar(128) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`route` enum('provider','managed') NOT NULL,
	`outcome` enum('allowed','receipt_reused','blocked','uncertain','unsupported_input','unavailable','policy_changed') NOT NULL,
	`policy_set_revision` int,
	`policies` json NOT NULL,
	`failed_policies` json NOT NULL,
	`evaluator_model` varchar(128),
	`extractor_version` varchar(64) NOT NULL,
	`decision_version` varchar(64) NOT NULL,
	`latency_ms` int NOT NULL,
	`evaluator_input_tokens` int,
	`evaluator_output_tokens` int,
	`evaluator_attempts` int NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `gateway_governance_decision_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_governance_decision_decision_id` UNIQUE(`decision_id`)
);
--> statement-breakpoint
CREATE INDEX `gateway_governance_admission_expires` ON `gateway_governance_admission` (`expires_at`);--> statement-breakpoint
CREATE INDEX `gateway_governance_decision_org_time` ON `gateway_governance_decision` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `gateway_governance_decision_created` ON `gateway_governance_decision` (`created_at`);