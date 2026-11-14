CREATE TABLE `categories` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY,
	`code` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`category_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`supplier_id` text,
	`minimum_quantity` real NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_materials_category_id_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`),
	CONSTRAINT `fk_materials_unit_id_units_id_fk` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`),
	CONSTRAINT `fk_materials_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`),
	CONSTRAINT "material_minimum_valid" CHECK("minimum_quantity" between 0 and 1000000000)
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`contact` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `units` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE INDEX `materials_status_name` ON `materials` (`archived`,`name`,`id`);--> statement-breakpoint
CREATE INDEX `materials_category` ON `materials` (`category_id`);--> statement-breakpoint
CREATE INDEX `materials_unit` ON `materials` (`unit_id`);--> statement-breakpoint
CREATE INDEX `materials_supplier` ON `materials` (`supplier_id`);