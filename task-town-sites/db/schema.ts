import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";

export const families = sqliteTable("families", {
  id: text("id").primaryKey(), code: text("code").notNull().unique(),
  name: text("name").notNull(), created_at: text("created_at").notNull(),
});
export const parents = sqliteTable("parents", {
  id: text("id").primaryKey(), family_id: text("family_id").notNull().references(() => families.id),
  username: text("username").notNull().unique(), display_name: text("display_name").notNull(),
  password_hash: text("password_hash").notNull(), created_at: text("created_at").notNull(),
});
export const children = sqliteTable("children", {
  id: text("id").primaryKey(), family_id: text("family_id").notNull().references(() => families.id),
  login_name: text("login_name").notNull(), display_name: text("display_name").notNull(),
  pin_hash: text("pin_hash").notNull(), balance: integer("balance").notNull().default(0),
  created_at: text("created_at").notNull(),
}, t => [uniqueIndex("family_login").on(t.family_id, t.login_name), check("balance_range", sql`${t.balance} BETWEEN 0 AND 1000000000`)]);
export const sessions = sqliteTable("sessions", {
  token_hash: text("token_hash").primaryKey(), role: text("role", { enum: ["parent", "kid"] }).notNull(),
  user_id: text("user_id").notNull(), credential_hash: text("credential_hash").notNull(),
  csrf_token: text("csrf_token").notNull(), expires_at: integer("expires_at").notNull(),
}, t => [index("session_expiry").on(t.expires_at)]);
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(), family_id: text("family_id").notNull().references(() => families.id),
  child_id: text("child_id").notNull().references(() => children.id), title: text("title").notNull(),
  description: text("description").notNull(), category: text("category").notNull(),
  reward: integer("reward").notNull(), recurrence: text("recurrence", { enum: ["once", "daily"] }).notNull(),
  due_at: text("due_at"), photo_required: integer("photo_required").notNull().default(0),
  active: integer("active").notNull().default(1), created_at: text("created_at").notNull(),
}, t => [index("tasks_child").on(t.child_id, t.created_at), check("task_reward_range", sql`${t.reward} BETWEEN 1 AND 1000`), check("task_active", sql`${t.active} IN (0,1)`), check("task_photo", sql`${t.photo_required} IN (0,1)`)]);
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(), task_id: text("task_id").notNull().references(() => tasks.id),
  family_id: text("family_id").notNull().references(() => families.id), child_id: text("child_id").notNull().references(() => children.id),
  period_key: text("period_key").notNull(), status: text("status", { enum: ["claimed", "submitted", "approved"] }).notNull(),
  note: text("note").notNull().default(""), review_comment: text("review_comment").notNull().default(""),
  photo: text("photo"), photo_type: text("photo_type"), claimed_at: text("claimed_at").notNull(),
  submitted_at: text("submitted_at"), reviewed_at: text("reviewed_at"), reviewer_id: text("reviewer_id").references(() => parents.id),
}, t => [uniqueIndex("task_period").on(t.task_id, t.child_id, t.period_key), index("runs_family").on(t.family_id, t.claimed_at), index("runs_child").on(t.child_id, t.claimed_at)]);
export const rewards = sqliteTable("rewards", {
  id: text("id").primaryKey(), family_id: text("family_id").notNull().references(() => families.id),
  title: text("title").notNull(), price: integer("price").notNull(), icon: text("icon").notNull(),
  active: integer("active").notNull().default(1), created_at: text("created_at").notNull(),
}, t => [index("rewards_family").on(t.family_id, t.created_at), check("reward_price", sql`${t.price} BETWEEN 1 AND 100000`), check("reward_active", sql`${t.active} IN (0,1)`)]);
export const redemptions = sqliteTable("redemptions", {
  id: text("id").primaryKey(), family_id: text("family_id").notNull().references(() => families.id),
  child_id: text("child_id").notNull().references(() => children.id), reward_id: text("reward_id").notNull().references(() => rewards.id),
  title: text("title").notNull(), price: integer("price").notNull(), request_key: text("request_key").notNull(),
  status: text("status", { enum: ["pending", "fulfilled", "rejected"] }).notNull(),
  comment: text("comment").notNull().default(""), created_at: text("created_at").notNull(), reviewed_at: text("reviewed_at"),
}, t => [uniqueIndex("child_request").on(t.child_id, t.request_key), index("redemption_family").on(t.family_id, t.created_at)]);
export const ledger = sqliteTable("ledger", {
  id: text("id").primaryKey(), family_id: text("family_id").notNull().references(() => families.id),
  child_id: text("child_id").notNull().references(() => children.id), delta: integer("delta").notNull(),
  balance_after: integer("balance_after").notNull(), kind: text("kind").notNull(),
  reference_id: text("reference_id").notNull(), note: text("note").notNull(), created_at: text("created_at").notNull(),
}, t => [uniqueIndex("event_reference").on(t.kind, t.reference_id), index("ledger_child").on(t.child_id, t.created_at), index("ledger_family").on(t.family_id, t.created_at), check("ledger_balance_range", sql`${t.balance_after} BETWEEN 0 AND 1000000000`)]);
export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(), hits: integer("hits").notNull(), expires_at: integer("expires_at").notNull(),
}, t => [index("rate_expiry").on(t.expires_at)]);
