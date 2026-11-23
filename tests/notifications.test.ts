import { it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, hash, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// Integration fixtures must not register an app or send to the developer's desktop.
vi.mock('../apps/service/src/native-notifications.js', () => ({
  nativeNotificationsAvailable: () => false,
  prepareNativeNotifications: async () => {},
  sendNativeNotification: vi.fn(),
}));

it('defaults alerts on, respects opt-out, and accepts each received event', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-notification-health-')));
  const user = s.createOwner('Owner');
  const { app } = await createApp(s);
  const headers = { cookie: 'workspace=' + s.newSession(user.id), 'x-workspace-request': '1' };
  try {
    const status = (await app.inject({ url: '/api/notifications', headers })).json();
    expect(status.nativeAvailable).toBe(false);
    expect(status.browserSubscriptions).toBe(0);
    expect(status.preferences.enabled).toBe(true);
    const disabled = await app.inject({
      method: 'PUT',
      url: '/api/notifications',
      headers,
      payload: { enabled: false, sound: true, privatePreview: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/notifications', headers })).json().preferences.enabled,
    ).toBe(false);
    const message = s.addMessage(
      s.createEmployee(user.id, { name: 'Agent', harness: 'codex' }).dmId,
      user.id,
      user.name,
      'human',
      'A notification event',
    );
    s.run('INSERT INTO inbox VALUES(?,?,0,?)', user.id, message.id, now());
    s.emit(
      'notification.message',
      message.conversationId,
      { id: message.id, authorName: 'Agent', text: 'A notification event' },
      user.id,
    );
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(s.setting('notifications.delivery.' + user.id, null)).toBeNull();
    const enabled = await app.inject({
      method: 'PUT',
      url: '/api/notifications',
      headers,
      payload: { enabled: true, sound: true, privatePreview: false },
    });
    expect(enabled.statusCode).toBe(200);
    s.emit(
      'notification.message',
      message.conversationId,
      { id: message.id, authorName: 'Agent', text: 'A notification event' },
      user.id,
    );
    const ack = await app.inject({
      method: 'POST',
      url: '/api/notifications/ack',
      headers,
      payload: { messageId: message.id },
    });
    expect(ack.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(s.setting('notifications.delivery.' + user.id, null)).toBeNull();
    s.emit(
      'notification.message',
      message.conversationId,
      { id: message.id, authorName: 'Agent', text: 'A notification event' },
      user.id,
    );
    await new Promise((resolve) => setTimeout(resolve, 1700));
    // Ordinary messages stay unread without an alert; requests for the human alert.
    expect(s.setting('notifications.delivery.' + user.id, null)).toBeNull();
    s.emit('decision.created', message.conversationId, { id: uid(), kind: 'question' }, user.id);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(s.setting('notifications.delivery.' + user.id, null).channel).toBe('none');
  } finally {
    await app.close();
  }
}, 20000);
