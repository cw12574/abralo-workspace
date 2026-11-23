import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { buildReplyTimeline } from '../apps/web/src/reply-timeline.js';

it('records where each step happened in the reply and keeps paragraphs separate', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-step-order-')));
  const user = s.createOwner('Owner');
  const agent = s.createEmployee(user.id, {
    name: 'Engineer',
    harness: 'codex',
    model: '',
    role: '',
    cwd: '',
    instructions: '',
  });
  const { app, supervisor } = await createApp(s);
  supervisor.adapters.codex = {
    info: async () => ({}) as any,
    dispose: async () => {},
    run: async (input) => {
      input.emit({ type: 'activity', id: 'tools', data: { type: 'tool', title: 'Workspace tools', state: 'complete' } });
      input.emit({ type: 'text', text: "I'll check the code." });
      input.emit({ type: 'activity', id: 'read', data: { type: 'tool', title: 'Read', state: 'running' } });
      input.emit({ type: 'activity', id: 'read', data: { type: 'tool', append: '\n\nResult:\nok', state: 'complete' } });
      input.emit({ type: 'text', text: 'Found it.' });
      input.emit({ type: 'complete' });
    },
  };
  const headers = { cookie: 'workspace=' + s.newSession(user.id), 'x-workspace-request': '1' };
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${agent.dmId}/messages`,
      headers,
      payload: { text: 'Please look', key: uid(), recipients: [agent.id] },
    });
    expect(res.statusCode).toBe(200);
    await supervisor.dispatch();
    await Promise.all([...supervisor.inflight]);
    const reply = (
      await app.inject({ url: `/api/conversations/${agent.dmId}/messages?activity=summary`, headers })
    )
      .json()
      .messages.find((m: any) => m.runId);
    expect(reply.text).toBe("I'll check the code.\n\nFound it.");
    const read = reply.activity.find((a: any) => a.title === 'Read');
    expect(read).toMatchObject({ state: 'complete', textOffset: "I'll check the code.".length });
    const timeline = buildReplyTimeline(reply.text, reply.activity).map((item) =>
      item.kind === 'text'
        ? reply.text.slice(item.start, item.end).trim()
        : item.steps.map((step) => step.title),
    );
    expect(timeline).toEqual([
      ['Workspace tools'],
      "I'll check the code.",
      ['Read'],
      'Found it.',
    ]);
  } finally {
    await app.close();
  }
});
