CREATE TABLE `children` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`login_name` text NOT NULL,
	`display_name` text NOT NULL,
	`pin_hash` text NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "balance_range" CHECK("children"."balance" BETWEEN 0 AND 1000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `family_login` ON `children` (`family_id`,`login_name`);--> statement-breakpoint
CREATE TABLE `families` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `families_code_unique` ON `families` (`code`);--> statement-breakpoint
CREATE TABLE `ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`child_id` text NOT NULL,
	`delta` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`kind` text NOT NULL,
	`reference_id` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_balance_range" CHECK("ledger"."balance_after" BETWEEN 0 AND 1000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_reference` ON `ledger` (`kind`,`reference_id`);--> statement-breakpoint
CREATE INDEX `ledger_child` ON `ledger` (`child_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ledger_family` ON `ledger` (`family_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `parents` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parents_username_unique` ON `parents` (`username`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`hits` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_expiry` ON `rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`child_id` text NOT NULL,
	`reward_id` text NOT NULL,
	`title` text NOT NULL,
	`price` integer NOT NULL,
	`request_key` text NOT NULL,
	`status` text NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`reviewed_at` text,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reward_id`) REFERENCES `rewards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `child_request` ON `redemptions` (`child_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `redemption_family` ON `redemptions` (`family_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rewards` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`title` text NOT NULL,
	`price` integer NOT NULL,
	`icon` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reward_price" CHECK("rewards"."price" BETWEEN 1 AND 100000),
	CONSTRAINT "reward_active" CHECK("rewards"."active" IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `rewards_family` ON `rewards` (`family_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`family_id` text NOT NULL,
	`child_id` text NOT NULL,
	`period_key` text NOT NULL,
	`status` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`review_comment` text DEFAULT '' NOT NULL,
	`photo` text,
	`photo_type` text,
	`claimed_at` text NOT NULL,
	`submitted_at` text,
	`reviewed_at` text,
	`reviewer_id` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `parents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_period` ON `runs` (`task_id`,`child_id`,`period_key`);--> statement-breakpoint
CREATE INDEX `runs_family` ON `runs` (`family_id`,`claimed_at`);--> statement-breakpoint
CREATE INDEX `runs_child` ON `runs` (`child_id`,`claimed_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_hash` text NOT NULL,
	`csrf_token` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`child_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`reward` integer NOT NULL,
	`recurrence` text NOT NULL,
	`due_at` text,
	`photo_required` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_reward_range" CHECK("tasks"."reward" BETWEEN 1 AND 1000),
	CONSTRAINT "task_active" CHECK("tasks"."active" IN (0,1)),
	CONSTRAINT "task_photo" CHECK("tasks"."photo_required" IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `tasks_child` ON `tasks` (`child_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER children_limit BEFORE INSERT ON children
BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM children WHERE family_id=NEW.family_id)>=20
    THEN RAISE(ABORT,'child_limit') END;
END;
--> statement-breakpoint
CREATE TRIGGER ledger_apply AFTER INSERT ON ledger
BEGIN
  UPDATE children SET balance=balance+NEW.delta WHERE id=NEW.child_id;
END;
--> statement-breakpoint
CREATE TRIGGER run_award AFTER UPDATE OF status ON runs
WHEN OLD.status='submitted' AND NEW.status='approved'
BEGIN
  INSERT INTO ledger(id,family_id,child_id,delta,balance_after,kind,reference_id,note,created_at)
    SELECT lower(hex(randomblob(16))),NEW.family_id,NEW.child_id,t.reward,c.balance+t.reward,
      'task_reward',NEW.id,'完成任务：'||t.title,NEW.reviewed_at
    FROM tasks t JOIN children c ON c.id=NEW.child_id WHERE t.id=NEW.task_id;
END;
--> statement-breakpoint
CREATE TRIGGER redemption_charge AFTER INSERT ON redemptions
BEGIN
  INSERT INTO ledger(id,family_id,child_id,delta,balance_after,kind,reference_id,note,created_at)
    SELECT lower(hex(randomblob(16))),NEW.family_id,NEW.child_id,-NEW.price,c.balance-NEW.price,
      'redemption',NEW.id,'申请兑换：'||NEW.title,NEW.created_at
    FROM children c WHERE c.id=NEW.child_id;
END;
--> statement-breakpoint
CREATE TRIGGER redemption_refund AFTER UPDATE OF status ON redemptions
WHEN OLD.status='pending' AND NEW.status='rejected'
BEGIN
  INSERT INTO ledger(id,family_id,child_id,delta,balance_after,kind,reference_id,note,created_at)
    SELECT lower(hex(randomblob(16))),NEW.family_id,NEW.child_id,NEW.price,c.balance+NEW.price,
      'redemption_refund',NEW.id,'退还星星：'||NEW.title,NEW.reviewed_at
    FROM children c WHERE c.id=NEW.child_id;
END;
