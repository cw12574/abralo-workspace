import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store, uid } from '../apps/service/src/store.js';
import { Work, registerWorkRoutes } from '../apps/service/src/work.js';

it('retrieves cards for the displayed history, including older completed work, with conversation isolation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-work-history-'));
  const store = new Store(dir);
  const owner = store.createOwner('Owner');
  const agent = store.createEmployee(owner.id, {
    name: 'Assistant',
    harness: 'codex',
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  const other = store.createEmployee(owner.id, {
    name: 'Other',
    harness: 'codex',
    model: '',
    cwd: '',
    role: '',
    instructions: '',
  });
  const work = new Work(store);
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as any).user = owner;
  });
  registerWorkRoutes(app, work);
  try {
    const cards = Array.from({ length: 25 }, (_, i) => {
      const message = store.addMessage(agent.dmId, owner.id, 'Owner', 'human', `Request ${i}`);
      const card = work.start(
        {
          id: uid(),
          user_id: owner.id,
          conversation_id: agent.dmId,
          message_id: message.id,
        },
        { title: `Task ${i}`, doneWhen: ['Done'], proofPlan: ['Check'] },
      );
      work.change(card.id, owner.id, agent.dmId, {
        status: 'complete',
        checks: [{ label: 'Check', result: 'passed' }],
      });
      store.run(
        'UPDATE work_items SET updated_at=? WHERE id=?',
        new Date(i * 1000).toISOString(),
        card.id,
      );
      return card;
    });
    expect(work.list(owner.id, agent.dmId).map((item) => item.id)).not.toContain(cards[0].id);
    const response = await app.inject({
      url: `/api/work?conversationId=${agent.dmId}&messageIds=${cards[0].requestMessageId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((item: any) => item.id)).toEqual([cards[0].id]);
    work.change(cards[0].id, owner.id, agent.dmId, { summary: 'New evidence' });
    expect(work.list(owner.id, agent.dmId, [cards[0].requestMessageId])[0]).toMatchObject({
      requestMessageId: cards[0].requestMessageId,
      summary: 'New evidence',
      effectiveStatus: 'complete',
    });
    expect(work.list(owner.id, other.dmId, [cards[0].requestMessageId])).toEqual([]);
    expect(
      work.list(
        owner.id,
        agent.dmId,
        cards.map((card) => card.requestMessageId),
      ),
    ).toHaveLength(25);
    expect(work.list(owner.id, agent.dmId, [])).toEqual([]);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
