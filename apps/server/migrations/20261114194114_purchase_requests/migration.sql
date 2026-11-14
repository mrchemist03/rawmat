CREATE TABLE `purchase_request_items` (
	`id` text PRIMARY KEY,
	`request_id` text NOT NULL,
	`position` integer NOT NULL,
	`material_id` text NOT NULL,
	`quantity` real NOT NULL,
	`received_quantity` real DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_purchase_request_items_request_id_purchase_requests_id_fk` FOREIGN KEY (`request_id`) REFERENCES `purchase_requests`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_purchase_request_items_material_id_materials_id_fk` FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`),
	CONSTRAINT "purchase_items_quantity_valid" CHECK("quantity" > 0 and "quantity" <= 1000000000),
	CONSTRAINT "purchase_items_received_valid" CHECK("received_quantity" between 0 and "quantity")
);
--> statement-breakpoint
CREATE TABLE `purchase_requests` (
	`id` text PRIMARY KEY,
	`number` text NOT NULL UNIQUE,
	`branch_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`supplier_id` text,
	`needed_on` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`submitted_at` integer,
	CONSTRAINT `fk_purchase_requests_branch_id_branches_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`),
	CONSTRAINT `fk_purchase_requests_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_purchase_requests_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`),
	CONSTRAINT "purchase_requests_status_valid" CHECK("status" in ('draft','submitted','approved','rejected','ordered','partially_received','received','cancelled')),
	CONSTRAINT "purchase_requests_revision_valid" CHECK("revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_items_request_material` ON `purchase_request_items` (`request_id`,`material_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_items_request_position` ON `purchase_request_items` (`request_id`,`position`);--> statement-breakpoint
CREATE INDEX `purchase_items_material` ON `purchase_request_items` (`material_id`);--> statement-breakpoint
CREATE INDEX `purchase_requests_status_created` ON `purchase_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `purchase_requests_needed` ON `purchase_requests` (`needed_on`);--> statement-breakpoint
CREATE INDEX `purchase_requests_branch` ON `purchase_requests` (`branch_id`);--> statement-breakpoint
CREATE INDEX `purchase_requests_requester` ON `purchase_requests` (`requested_by`);--> statement-breakpoint
CREATE INDEX `purchase_requests_supplier` ON `purchase_requests` (`supplier_id`);