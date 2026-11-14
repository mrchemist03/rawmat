CREATE TABLE `shipment_items` (
	`id` text PRIMARY KEY,
	`shipment_id` text NOT NULL,
	`position` integer NOT NULL,
	`material_id` text,
	`description` text,
	`quantity` text NOT NULL,
	`received_quantity` text,
	CONSTRAINT `fk_shipment_items_shipment_id_shipments_id_fk` FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`),
	CONSTRAINT `fk_shipment_items_material_id_materials_id_fk` FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`),
	CONSTRAINT "shipment_item_variant" CHECK(("material_id" is null) <> ("description" is null))
);
--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` text PRIMARY KEY,
	`tracking_number` text NOT NULL UNIQUE,
	`source_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`dispatched_on` text NOT NULL,
	`created_by` text NOT NULL,
	`status` text DEFAULT 'registered' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`received_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_shipments_source_id_branches_id_fk` FOREIGN KEY (`source_id`) REFERENCES `branches`(`id`),
	CONSTRAINT `fk_shipments_destination_id_branches_id_fk` FOREIGN KEY (`destination_id`) REFERENCES `branches`(`id`),
	CONSTRAINT `fk_shipments_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`),
	CONSTRAINT "shipment_branches_distinct" CHECK("source_id" <> "destination_id"),
	CONSTRAINT "shipment_status_valid" CHECK("status" in ('registered','picked_up','in_transit','out_for_delivery','delivered','exception','returned'))
);
--> statement-breakpoint
CREATE TABLE `tracking_events` (
	`id` text PRIMARY KEY,
	`shipment_id` text NOT NULL,
	`status` text NOT NULL,
	`code` text NOT NULL,
	`description` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`occurred_at` integer NOT NULL,
	`revision` integer NOT NULL,
	`source` text NOT NULL,
	CONSTRAINT `fk_tracking_events_shipment_id_shipments_id_fk` FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipment_items_position` ON `shipment_items` (`shipment_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `shipment_items_material_unique` ON `shipment_items` (`shipment_id`,`material_id`);--> statement-breakpoint
CREATE INDEX `shipment_items_material` ON `shipment_items` (`material_id`);--> statement-breakpoint
CREATE INDEX `shipments_status_date` ON `shipments` (`status`,`dispatched_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `tracking_events_revision` ON `tracking_events` (`shipment_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `tracking_events_event` ON `tracking_events` (`shipment_id`,`code`,`occurred_at`);