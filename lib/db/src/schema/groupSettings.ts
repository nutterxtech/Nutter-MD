import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const groupSettingsTable = pgTable("group_settings", {
  groupId: text("group_id").primaryKey(),
  antilink: boolean("antilink").notNull().default(false),
  antibadword: boolean("antibadword").notNull().default(false),
  antimention: boolean("antimention").notNull().default(false),
  customPrefix: text("custom_prefix"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGroupSettingsSchema = createInsertSchema(groupSettingsTable).omit({ updatedAt: true });
export type InsertGroupSettings = z.infer<typeof insertGroupSettingsSchema>;
export type GroupSettings = typeof groupSettingsTable.$inferSelect;
