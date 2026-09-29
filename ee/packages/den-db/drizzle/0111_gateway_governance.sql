CREATE TABLE `gateway_governance_audit` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`actor_id` varchar(64) NOT NULL,
	`action` enum('enabled','disabled','policy_created','policy_updated','policy_published','policy_archived') NOT NULL,
	`policy_id` varchar(64),
	`policy_revision` int,
	`settings_revision` int NOT NULL,
	`policy_set_revision` int NOT NULL,
	`processing_acknowledged` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `gateway_governance_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gateway_governance_policy_revision` (
	`organization_id` varchar(64) NOT NULL,
	`policy_id` varchar(64) NOT NULL,
	`revision` int NOT NULL,
	`snapshot` json NOT NULL,
	`created_by` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `gateway_governance_policy_revision_pk` PRIMARY KEY(`organization_id`,`policy_id`,`revision`)
);
--> statement-breakpoint
CREATE TABLE `gateway_governance_policy_set` (
	`organization_id` varchar(64) NOT NULL,
	`revision` int NOT NULL,
	`policies` json NOT NULL,
	`created_by` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `gateway_governance_policy_set_organization_id_revision_pk` PRIMARY KEY(`organization_id`,`revision`)
);
--> statement-breakpoint
CREATE TABLE `gateway_governance_policy` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`name` varchar(120) NOT NULL,
	`guidance` text NOT NULL,
	`status` enum('draft','active','archived') NOT NULL DEFAULT 'draft',
	`revision` int NOT NULL DEFAULT 1,
	`created_by` varchar(64) NOT NULL,
	`updated_by` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `gateway_governance_policy_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_governance_policy_revision` CHECK(`gateway_governance_policy`.`revision` >= 1)
);
--> statement-breakpoint
CREATE TABLE `gateway_governance_settings` (
	`organization_id` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`revision` int NOT NULL DEFAULT 1,
	`policy_set_revision` int NOT NULL DEFAULT 1,
	`updated_by` varchar(64),
	`processing_acknowledged_at` timestamp(3),
	`processing_acknowledged_by` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `gateway_governance_settings_organization_id` PRIMARY KEY(`organization_id`),
	CONSTRAINT `gateway_governance_settings_revisions` CHECK(`gateway_governance_settings`.`revision` >= 1 and `gateway_governance_settings`.`policy_set_revision` >= 1)
);
--> statement-breakpoint
CREATE INDEX `gateway_governance_audit_org_time` ON `gateway_governance_audit` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `gateway_governance_policy_org` ON `gateway_governance_policy` (`organization_id`);
--> statement-breakpoint
INSERT INTO `gateway_governance_policy_set` (`organization_id`, `revision`, `policies`)
SELECT `id`, 1, JSON_ARRAY() FROM `organization`;
--> statement-breakpoint
INSERT INTO `gateway_governance_settings` (`organization_id`, `enabled`, `revision`, `policy_set_revision`)
SELECT `id`, false, 1, 1 FROM `organization`;