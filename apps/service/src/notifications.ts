import webpush from 'web-push';
import { z } from 'zod';
import { ApiError, Store, uid } from './store.js';
import {
  nativeNotificationsAvailable,
  prepareNativeNotifications,
  sendNativeNotification,
} from './native-notifications.js';
const defaultPreferences = { enabled: true, sound: true, privatePreview: false };
export async function registerNotifications(app: any, s: Store) {
  if (!s.setting('inbox.backfilled')) {
    for (const row of s.all(
      "SELECT m.* FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.kind<>'system' AND m.superseded=0 AND length(m.text)>0 AND (m.run_id IS NULL OR r.state='completed') ORDER BY m.seq DESC LIMIT 200",
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
    browserSubscriptions: s.one('SELECT COUNT(*) n FROM subscriptions WHERE user_id=?', req.user.id)
      .n,
    lastDelivery: s.setting('notifications.delivery.' + req.user.id, null),
    preferences: s.setting('notifications.' + req.user.id, defaultPreferences),
  }));
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
  // Desktop alerts are only for a turn that finished (completed, failed or hit a
  // provider limit) or something that needs the human's approval or input. Other
  // messages stay in the unread inbox without an alert. A reply's text only
  // enriches the alert already pending for its finished turn.
  const pending = new Map<string, { timer: NodeJS.Timeout; required: boolean }>();
  app.post('/api/notifications/ack', async (req: any) => {
    const { messageId } = z.object({ messageId: z.string() }).parse(req.body);
    if (!s.one('SELECT 1 FROM inbox WHERE user_id=? AND message_id=?', req.user.id, messageId))
      throw new ApiError(404, 'Notification not found.');
    const key = req.user.id + ':' + messageId;
    const delivery = pending.get(key);
    if (delivery && !delivery.required) {
      clearTimeout(delivery.timer);
      pending.delete(key);
    }
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
          s.set('notifications.delivery.' + event.userId, {
            channel: 'browser',
            at: Date.now(),
            error: String(e.message || e),
          });
          console.error('Browser notification failed:', e);
        });
    }
    s.set('notifications.delivery.' + event.userId, {
      channel: attempted ? 'browser' : 'none',
      at: Date.now(),
      ...(attempted ? {} : { error: 'No browser subscription or native desktop channel.' }),
    });
  };
  app.post('/api/notifications/test', async (req: any) => {
    if (!nativeNotificationsAvailable(s, req.user.id))
      return { channel: 'browser', message: 'Use the browser notification test.' };
    await sendNativeNotification(s, {
      title: 'Abralo',
      body: 'A test notification from Abralo.',
      sound: !!s.setting('notifications.' + req.user.id, defaultPreferences).sound,
    });
    return {
      channel: 'windows',
      message: 'Sent to Windows. Check the notification center if no banner appears.',
    };
  });
  const onEvent = (source: any) => {
    let event = source;
    let required = false;
    if (
      source.type === 'run.changed' &&
      ['completed', 'failed', 'provider_limited'].includes(
        source.payload.state,
      )
    ) {
      const run = source.payload;
      if (s.setting('briefing.message.' + run.message_id)) return;
      const employee = s.employee(run.employee_id);
      event = {
        ...source,
        userId: run.user_id,
        payload: {
          id: run.response_id || run.id,
          authorName: employee?.name || 'Abralo',
          text:
            run.state === 'completed'
              ? 'Finished a turn.'
              : run.state === 'provider_limited'
                ? 'Paused because of a provider limit.'
                : 'Turn failed.',
          threadId: s.one('SELECT thread_id FROM messages WHERE id=?', run.message_id)?.thread_id,
        },
      };
      required = true;
    } else if (
      source.type === 'decision.created' ||
      source.type === 'connection.requested' ||
      source.type === 'proposal.created' ||
      (source.type === 'connection.action' && source.payload.state === 'awaiting_approval')
    ) {
      const run =
        source.payload.runId &&
        s.one('SELECT employee_id FROM runs WHERE id=?', source.payload.runId);
      event = {
        ...source,
        payload: {
          id: source.payload.id,
          authorName: run ? s.employee(run.employee_id)?.name || 'Abralo' : 'Abralo',
          text:
            source.type === 'decision.created' && source.payload.kind === 'question'
              ? 'Needs your input.'
              : 'Needs your approval.',
        },
      };
      required = true;
    } else if (source.type === 'notification.message') {
      if (!pending.get(source.userId + ':' + source.payload?.id)?.required) return;
    } else return;
    if (
      !event.userId ||
      !event.payload.id ||
      !s.one(
        'SELECT 1 FROM members WHERE conversation_id=? AND user_id=?',
        event.conversationId,
        event.userId,
      )
    )
      return;
    const prefs = s.setting('notifications.' + event.userId, defaultPreferences);
    if (!prefs.enabled) return;
    const key = event.userId + ':' + event.payload.id;
    const previous = pending.get(key);
    if (previous) {
      clearTimeout(previous.timer);
      required ||= previous.required;
    }
    const timer = setTimeout(() => {
      pending.delete(key);
      const prefs = s.setting('notifications.' + event.userId, defaultPreferences);
      if (!prefs.enabled) return;
      if (nativeNotificationsAvailable(s, event.userId)) {
        let failed = false;
        void sendNativeNotification(
          s,
          {
            title: event.payload.authorName,
            body: prefs.privatePreview
              ? 'You have a new message.'
              : event.payload.text.slice(0, 160),
            sound: !!prefs.sound,
          },
          () => {
            failed = true;
            sendBrowserPush(event, prefs);
          },
        )
          .then(() => {
            if (!failed)
              s.set('notifications.delivery.' + event.userId, {
                channel: 'windows',
                at: Date.now(),
              });
          })
          .catch((error) => {
            console.error('Windows notification failed:', error);
            sendBrowserPush(event, prefs);
          });
      } else sendBrowserPush(event, prefs);
    }, 1500);
    pending.set(key, { timer, required });
  };
  s.bus.on('event', onEvent);
  void prepareNativeNotifications(s).catch((error) =>
    console.error('Could not prepare Windows notifications:', error),
  );
  app.addHook('onClose', async () => {
    s.bus.off('event', onEvent);
    for (const delivery of pending.values()) clearTimeout(delivery.timer);
    pending.clear();
  });
}
