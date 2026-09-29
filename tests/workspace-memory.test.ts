import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

it('keeps workspace facts visible across rooms and editable from settings', async () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-memory-')));
  const { app } = await createApp(s);
  try {
    const owner = s.createOwner('Chris');
    const agent = s.createEmployee(owner.id, {
      name: 'Chief of Staff',
      role: 'Coordinator',
      harness: 'codex',
      model: '',
      cwd: '',
      instructions: '',
    });
    const source = s.addMessage(
      agent.dmId,
      owner.id,
      owner.name,
      'human',
      'PollyTalks charges IUK two dollars per student each month.',
    );
    const memoryId = uid();
    s.run(
      'INSERT INTO memories(id,conversation_id,author_id,content,source_id,created_at,scope,owner_id) VALUES(?,?,?,?,?,?,?,?)',
      memoryId,
      agent.dmId,
      agent.id,
      'PollyTalks charges IUK $2 per student per month.',
      source.id,
      new Date().toISOString(),
      'workspace',
      owner.id,
    );
    s.run(
      'INSERT INTO memory_fts VALUES(?,?)',
      memoryId,
      'PollyTalks charges IUK $2 per student per month.',
    );
    const session = await app.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token: s.bootstrapToken },
      headers: { 'x-workspace-request': '1' },
    });
    const cookie = (session.headers['set-cookie'] as string).split(';')[0];
    const headers = { cookie, 'x-workspace-request': '1' };
    const memories = await app.inject({ url: '/api/memories', headers });
    expect(memories.statusCode).toBe(200);
    expect(memories.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: memoryId,
          scope: 'workspace',
          source_conversation_name: agent.name,
          source_author: owner.name,
        }),
      ]),
    );
    const other = s.createOwner('Ada');
    const otherHeaders = {
      cookie: 'workspace=' + s.newSession(other.id),
      'x-workspace-request': '1',
    };
    expect((await app.inject({ url: '/api/memories', headers: otherHeaders })).json()).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/memories/${memoryId}`,
          payload: { deleted: true },
          headers: otherHeaders,
        })
      ).statusCode,
    ).toBe(403);
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/memories/${memoryId}`,
      payload: { content: 'Updated pricing fact.' },
      headers,
    });
    expect(edited.statusCode).toBe(200);
    expect(s.one('SELECT content FROM memories WHERE id=?', memoryId).content).toBe(
      'Updated pricing fact.',
    );
    expect(s.all('SELECT * FROM memory_fts WHERE memory_fts MATCH ?', '"Updated"')).toHaveLength(1);
  } finally {
    await app.close();
    s.close();
  }
});
