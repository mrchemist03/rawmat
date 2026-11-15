ALTER TABLE `shipments` ADD `next_poll_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shipments` ADD `poll_lease_until` integer;--> statement-breakpoint
ALTER TABLE `shipments` ADD `poll_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shipments` ADD `last_polled_at` integer;--> statement-breakpoint
ALTER TABLE `shipments` ADD `tracking_changed_at` integer;--> statement-breakpoint
ALTER TABLE `shipments` ADD `last_refresh_at` integer;--> statement-breakpoint
ALTER TABLE `tracking_events` ADD `raw` text;--> statement-breakpoint
CREATE INDEX `shipments_next_poll` ON `shipments` (`next_poll_at`) WHERE "shipments"."received_at" is null and "shipments"."status" not in ('delivered', 'returned');--> statement-breakpoint
CREATE INDEX `tracking_events_timeline` ON `tracking_events` (`shipment_id`,`occurred_at`,`revision`);--> statement-breakpoint
UPDATE `shipments`
SET `tracking_changed_at` = (
  SELECT MAX(`occurred_at`) FROM `tracking_events` WHERE `shipment_id` = `shipments`.`id`
);
