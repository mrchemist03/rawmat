ALTER TABLE `purchase_requests` ADD `overdue_notified_on` text;--> statement-breakpoint
ALTER TABLE `shipments` ADD `stale_notified_activity_at` integer;--> statement-breakpoint
UPDATE `purchase_requests`
SET `overdue_notified_on` = `needed_on`
WHERE EXISTS (SELECT 1 FROM `notification_outbox` AS queued
  WHERE queued.`dedupe_key` = 'purchase.overdue:' || `purchase_requests`.`id` || ':' || `purchase_requests`.`needed_on`);--> statement-breakpoint
UPDATE `shipments`
SET `stale_notified_activity_at` = coalesce(`tracking_changed_at`, `created_at`)
WHERE EXISTS (SELECT 1 FROM `notification_outbox` AS queued
  WHERE queued.`dedupe_key` = 'shipment.stale:' || `shipments`.`id` || ':' || coalesce(`shipments`.`tracking_changed_at`, `shipments`.`created_at`));--> statement-breakpoint
UPDATE `notification_outbox` SET `message` = '', `data` = '{}', `recipients` = '[]' WHERE `state` = 'sent';
