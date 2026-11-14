ALTER TABLE `audit_log` ADD `before` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `after` text;--> statement-breakpoint
ALTER TABLE `materials` ADD `name_normalized` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `materials` ADD `legacy_duplicate` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `materials` ADD `merged_into_id` text REFERENCES materials(id);--> statement-breakpoint
UPDATE materials SET name_normalized = rawmat_normalize_name(name);
--> statement-breakpoint
UPDATE materials SET legacy_duplicate = 1 WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY name_normalized, unit_id ORDER BY archived, id) AS rank
    FROM materials WHERE name_normalized <> ''
  ) WHERE rank > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `materials_normalized_unit_unique` ON `materials` (`name_normalized`,`unit_id`) WHERE "materials"."merged_into_id" is null and "materials"."legacy_duplicate" = 0 and "materials"."name_normalized" <> '';--> statement-breakpoint
CREATE INDEX `materials_merge_target` ON `materials` (`merged_into_id`);
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;
