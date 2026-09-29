import webpush from 'web-push';
import { z } from 'zod';
import { Store, uid } from './store.js';
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
    preferences: s.setting('notifications.' + req.user.id, {
      enabled: false,
      sound: true,
      privatePreview: false,
    }),
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
  // Native/browser routing is coordinated by the page while connected. Push is
  // sent only for an opted-in recipient without a recently visible page lease.
  app.post('/api/notifications/presence', async (req: any) => {
    s.set('presence.' + req.user.id, { at: Date.now(), visible: !!req.body?.visible });
    return { ok: true };
  });
  const onEvent = (event: any) => {
    if (event.type !== 'notification.message' || !event.userId) return;
    const prefs = s.setting('notifications.' + event.userId, {}),
      presence = s.setting('presence.' + event.userId, {});
    if (!prefs.enabled || (presence.visible && Date.now() - presence.at < 45000)) return;
    for (const row of s.all('SELECT * FROM subscriptions WHERE user_id=?', event.userId)) {
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
        });
    }
  };
  s.bus.on('event', onEvent);
  app.addHook('onClose', async () => {
    s.bus.off('event', onEvent);
  });
}
