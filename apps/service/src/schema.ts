import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const humans = sqliteTable('humans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  password: text('password'),
  createdAt: text('created_at').notNull(),
});
export const events = sqliteTable('events', {
  cursor: integer('cursor').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  type: text('type').notNull(),
  conversationId: text('conversation_id'),
  userId: text('user_id'),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
});
