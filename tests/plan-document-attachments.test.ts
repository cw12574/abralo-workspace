import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store';
import { attachArchivedPlanDocuments } from '../apps/service/src/plan-document-attachments';

it('makes archived plans previewable without losing versions, original records, text or attachments', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'plan-documents-')));
  const owner = store.createOwner('Owner');
  const agent = store.createEmployee(owner.id, {
    name: 'Atlas',
    harness: 'codex',
    role: '',
    model: '',
    cwd: '',
    instructions: '',
  });
  const originalFile = uid();
  const message = store.addMessage(
    agent.dmId,
    agent.id,
    agent.name,
    'agent',
    'Original discussion',
    null,
    [originalFile],
  );
  const deleted = store.addMessage(agent.dmId, agent.id, agent.name, 'agent', 'Removed');
  store.run('UPDATE messages SET deleted_at=? WHERE id=?', now(), deleted.id);
  const plan = {
    title: 'A considered plan',
    state: 'agreed',
    authorName: 'Atlas',
    revisions: [
      {
        title: 'First proposal',
        body: 'Original approach',
        responsibilities: [{ name: 'Atlas', responsibility: 'Research' }],
      },
      {
        title: 'Agreed proposal',
        body: 'Updated approach',
        responsibilities: [{ name: 'Atlas', responsibility: 'Implement' }],
      },
    ],
  };
  for (const id of [message.id, deleted.id])
    store.run(
      'INSERT INTO plans VALUES(?,?,?,?,?,?)',
      uid(),
      id,
      agent.dmId,
      agent.id,
      JSON.stringify(plan),
      now(),
    );
  store.set('migration.plan-preview-documents', false);
  try {
    attachArchivedPlanDocuments(store);
    attachArchivedPlanDocuments(store);
    const archived = store.all('SELECT * FROM attachments');
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      conversation_id: agent.dmId,
      user_id: owner.id,
      mime: 'text/markdown',
    });
    const content = readFileSync(archived[0].path, 'utf8');
    expect(content).toContain('Prepared by Atlas');
    expect(content).toContain('Status when archived: Agreed');
    expect(content).toContain('Original approach');
    expect(content).toContain('Updated approach');
    expect(content).toContain('Research');
    expect(content).toContain('Implement');
    expect(content.indexOf('Version 2')).toBeLessThan(content.indexOf('Version 1'));
    const row = store.one('SELECT * FROM messages WHERE id=?', message.id);
    expect(row.text).toBe('Original discussion');
    expect(JSON.parse(row.attachments)).toEqual([originalFile, archived[0].id]);
    expect(store.all('SELECT * FROM plans')).toHaveLength(2);
    expect(
      JSON.parse(store.one('SELECT attachments FROM messages WHERE id=?', deleted.id).attachments),
    ).toEqual([]);
  } finally {
    store.close();
  }
}, 15000);
