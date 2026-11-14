CREATE TABLE `material_costs` (
	`material_id` text NOT NULL,
	`currency` text NOT NULL,
	`last_unit_price_minor` integer NOT NULL,
	`average_unit_price_minor` integer NOT NULL,
	CONSTRAINT `fk_material_costs_material_id_materials_id_fk` FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_item_costs` (
	`item_id` text PRIMARY KEY,
	`unit_price_minor` integer NOT NULL,
	`currency` text NOT NULL,
	CONSTRAINT `fk_purchase_item_costs_item_id_purchase_request_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `purchase_request_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT "purchase_item_price_valid" CHECK("unit_price_minor" between 0 and 1000000000000),
	CONSTRAINT "purchase_item_currency_valid" CHECK("currency" glob '[A-Z][A-Z][A-Z]')
);
--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` text PRIMARY KEY,
	`branch_id` text NOT NULL,
	`material_id` text NOT NULL,
	`quantity` text NOT NULL,
	`kind` text NOT NULL,
	`reference_id` text NOT NULL,
	`reference_item_id` text NOT NULL,
	`reference_revision` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	CONSTRAINT `fk_stock_movements_branch_id_branches_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`),
	CONSTRAINT `fk_stock_movements_material_id_materials_id_fk` FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`)
);
--> statement-breakpoint
ALTER TABLE `purchase_request_items` ADD `received_exact` text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_requests` ADD `decision_reason` text;--> statement-breakpoint
ALTER TABLE `purchase_requests` ADD `ordered_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `material_costs_material_currency` ON `material_costs` (`material_id`,`currency`);--> statement-breakpoint
CREATE UNIQUE INDEX `stock_movements_reference` ON `stock_movements` (`kind`,`reference_id`,`reference_item_id`,`reference_revision`);--> statement-breakpoint
CREATE INDEX `stock_movements_material_branch` ON `stock_movements` (`material_id`,`branch_id`);
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock movements are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock movements are append-only');
END;
