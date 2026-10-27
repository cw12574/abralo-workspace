import webpush from 'web-push';
import { z } from 'zod';
import { ApiError, Store, uid } from './store.js';
import { nativeNotificationsAvailable, prepareNativeNotifications, sendNativeNotification } from './native-notifications.js';
const defaultPreferences = { enabled: true, sound: true, privatePreview: false };
export async function registerNotifications(app: any, s: Store) {
  if (!s.setting('inbox.backfilled')) {
    for (const row of s.all(
      "SELECT m.* FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.kind<>'system' AND length(m.text)>0 AND (m.run_id IS NULL OR r.state='completed') ORDER BY m.seq DESC LIMIT 200",
    ))
      s.recordNotifications(s.message(row), false);
    s.set('inbox.backfilled', true);
  }
  let keys = s.setting('push.keys');
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    s.set('push.keys', keys);
  }
  webpush.setVapidDetails('mailto:workspace@localhost.invalid', keys.publicKey, keys.privateKey);
  app.get('/api/notifications', async (req: any) => ({
    publicKey: keys.publicKey,
    nativeAvailable: nativeNotificationsAvailable(s, req.user.id),
    browserSubscriptions: s.one('SELECT COUNT(*) n FROM subscriptions WHERE user_id=?', req.user.id).n,
    lastDelivery: s.setting('notifications.delivery.' + req.user.id, null),
    preferences: s.setting('notifications.' + req.user.id, defaultPreferences),
  }));
  app.get('/api/notifications/inbox', async (req: any) => {
    const rows = s.all(
      `SELECT i.seen,i.created_at notification_at,m.*,c.name conversation_name,c.kind conversation_kind FROM inbox i JOIN messages m ON m.id=i.message_id JOIN conversations c ON c.id=m.conversation_id JOIN members member ON member.conversation_id=c.id AND member.user_id=i.user_id WHERE i.user_id=? ORDER BY i.seen,i.created_at DESC LIMIT 200`,
      req.user.id,
    );
    return {
      unread: s.one(
        `SELECT COUNT(*) n FROM inbox i JOIN messages m ON m.id=i.message_id JOIN members member ON member.conversation_id=m.conversation_id AND member.user_id=i.user_id WHERE i.user_id=? AND i.seen=0`,
        req.user.id,
      ).n,
      items: rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        threadId: row.thread_id,
        authorId: row.author_id,
        authorName: row.author_name,
        text: row.text.slice(0, 240),
        createdAt: row.created_at,
        seen: !!row.seen,
        conversationName: row.conversation_name,
        conversationKind: row.conversation_kind,
      })),
    };
  });
  app.post('/api/notifications/inbox/read', async (req: any) => {
    const body = z
      .object({ messageId: z.string().optional(), all: z.boolean().optional() })
      .parse(req.body);
    if (body.all) s.run('UPDATE inbox SET seen=1 WHERE user_id=?', req.user.id);
    else if (body.messageId)
      s.run(
        'UPDATE inbox SET seen=1 WHERE user_id=? AND message_id=?',
        req.user.id,
        body.messageId,
      );
    s.emit('inbox.changed', null, {}, req.user.id);
    return { ok: true };
  });
  app.put('/api/notifications', async (req: any) => {
    const p = z
      .object({ enabled: z.boolean(), sound: z.boolean(), privatePreview: z.boolean() })
      .parse(req.body);
    s.set('notifications.' + req.user.id, p);
    s.emit('notifications.preferences', null, p, req.user.id);
    return p;
  });
  app.post('/api/notifications/subscribe', async (req: any) => {
    const data = z
      .object({
        endpoint: z.url().startsWith('https://'),
        keys: z.object({ p256dh: z.string(), auth: z.string() }),
      })
      .parse(req.body);
    for (const row of s.all('SELECT * FROM subscriptions WHERE user_id=?', req.user.id))
      if (JSON.parse(row.data).endpoint === data.endpoint)
        s.run('DELETE FROM subscriptions WHERE id=?', row.id);
    s.run('INSERT INTO subscriptions VALUES(?,?,?)', uid(), req.user.id, JSON.stringify(data));
    return { ok: true };
  });
  app.delete('/api/notifications/subscribe', async (req: any) => {
    const { endpoint } = z.object({ endpoint: z.url().startsWith('https://') }).parse(req.body);
    for (const row of s.all('SELECT * FROM subscriptions WHERE user_id=?', req.user.id))
      if (JSON.parse(row.data).endpoint === endpoint)
        s.run('DELETE FROM subscriptions WHERE id=?', row.id);
    return { ok: true };
  });
  // A focused page acknowledges each event it actually receives. If it closes
  // or loses its stream, the deadline still sends a desktop alert.
  const pending = new Map<string, NodeJS.Timeout>();
  app.post('/api/notifications/ack', async (req: any) => {
    const { messageId } = z.object({ messageId: z.string() }).parse(req.body);
    if (!s.one('SELECT 1 FROM inbox WHERE user_id=? AND message_id=?', req.user.id, messageId))
      throw new ApiError(404, 'Notification not found.');
    const key = req.user.id + ':' + messageId;
    const timer = pending.get(key);
    if (timer) clearTimeout(timer);
    pending.delete(key);
    return { ok: true };
  });
  const sendBrowserPush = (event: any, prefs: any) => {
    let attempted = false;
    for (const row of s.all('SELECT * FROM subscriptions WHERE user_id=?', event.userId)) {
      attempted = true;
      const payload = {
        id: event.payload.id,
        title: event.payload.authorName,
        body: prefs.privatePreview ? 'You have a new message.' : event.payload.text.slice(0, 160),
        conversationId: event.conversationId,
        threadId: event.payload.threadId,
        silent: !prefs.sound,
      };
      void webpush
        .sendNotification(JSON.parse(row.data), JSON.stringify(payload), {
          TTL: 3600,
          topic: 'msg-' + event.payload.id.replace(/-/g, '').slice(0, 28),
        })
        .catch((e: any) => {
          if (e.statusCode === 404 || e.statusCode === 410)
            s.run('DELETE FROM subscriptions WHERE id=?', row.id);
          s.set('notifications.delivery.' + event.userId,
            { channel: 'browser', at: Date.now(), error: String(e.message || e) });
          console.error('Browser notification failed:', e);
        });
    }
    s.set('notifications.delivery.' + event.userId,
      { channel: attempted ? 'browser' : 'none', at: Date.now(),
        ...(attempted ? {} : { error: 'No browser subscription or native desktop channel.' }) });
  };
  app.post('/api/notifications/test', async (req: any) => {
    if (!nativeNotificationsAvailable(s, req.user.id))
      return { channel: 'browser', message: 'Use the browser notification test.' };
    await sendNativeNotification(s, {
      title: 'Abralo', body: 'A test notification from Abralo.',
      sound: !!s.setting('notifications.' + req.user.id, defaultPreferences).sound,
    });
    return { channel: 'windows', message: 'Sent to Windows. Check the notification center if no banner appears.' };
  });
  const onEvent = (event: any) => {
    if (event.type !== 'notification.message' || !event.userId) return;
    const prefs = s.setting('notifications.' + event.userId, defaultPreferences);
    if (!prefs.enabled) return;
    const key = event.userId + ':' + event.payload.id;
    const previous = pending.get(key);
    if (previous) clearTimeout(previous);
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      if (!s.setting('notifications.' + event.userId, defaultPreferences).enabled) return;
      if (nativeNotificationsAvailable(s, event.userId)) {
        void sendNativeNotification(s, {
          title: event.payload.authorName,
          body: prefs.privatePreview ? 'You have a new message.' : event.payload.text.slice(0, 160),
          sound: !!prefs.sound,
        }, () => sendBrowserPush(event, prefs))
          .then(() => s.set('notifications.delivery.' + event.userId,
            { channel: 'windows', at: Date.now() }))
          .catch((error) => {
            console.error('Windows notification failed:', error);
            sendBrowserPush(event, prefs);
          });
      } else sendBrowserPush(event, prefs);
    }, 1500));
  };
  s.bus.on('event', onEvent);
  void prepareNativeNotifications(s).catch((error) =>
    console.error('Could not prepare Windows notifications:', error));
  app.addHook('onClose', async () => {
    s.bus.off('event', onEvent);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  });
}
