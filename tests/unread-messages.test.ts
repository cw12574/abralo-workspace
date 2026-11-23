import { it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

vi.mock('../apps/service/src/native-notifications.js', () => ({
  nativeNotificationsAvailable: () => false,
  prepareNativeNotifications: async () => {},
  sendNativeNotification: vi.fn(),
}));

it('shares message counts and publishes read changes after saving the cursor', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'abralo-unread-')));
  const user = store.createOwner('Owner');
  const employee = store.createEmployee(user.id, { name: 'Engineer', harness: 'codex' });
  store.addMessage(employee.dmId, user.id, user.name, 'human', 'My own message');
  store.addMessage(employee.dmId, employee.id, employee.name, 'agent', 'First reply');
  const last = store.addMessage(employee.dmId, employee.id, employee.name, 'agent', 'Second reply');
  store.addMessage(employee.dmId, 'system', 'System', 'system', 'Internal event');
  const { app } = await createApp(store);
  const headers = { cookie: 'workspace=' + store.newSession(user.id), 'x-workspace-request': '1' };
  const unread = async () => (await app.inject({ url: '/api/workspace', headers })).json().conversations.find((c: any) => c.id === employee.dmId).unread;
  const cursors: number[] = [];
  store.bus.on('event', (event: any) => {
    if (event.type === 'inbox.changed') cursors.push(store.one('SELECT last_read FROM members WHERE user_id=? AND conversation_id=?', user.id, employee.dmId).last_read);
  });
  try {
    expect(await unread()).toBe(2);
    const result = await app.inject({ method: 'POST', url: `/api/conversations/${employee.dmId}/read`, headers, payload: { seq: last.seq } });
    expect(result.statusCode).toBe(200);
    expect(cursors).toEqual([last.seq]);
    expect(await unread()).toBe(0);
    // An older tab cannot move the read cursor backwards.
    await app.inject({ method: 'POST', url: `/api/conversations/${employee.dmId}/read`, headers, payload: { seq: last.seq - 1 } });
    expect(await unread()).toBe(0);
  } finally {
    await app.close();
    store.close();
  }
});
