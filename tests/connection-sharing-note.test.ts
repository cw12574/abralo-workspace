import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { ConnectionBroker } from '../apps/service/src/connections.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture() {
  const s = new Store(mkdtempSync(join(tmpdir(), 'sharing-note-')));
  const owner = s.createOwner('Chris');
  const first = s.createEmployee(owner.id, { name: 'First', harness: 'claude', model: '', cwd: '', role: '', instructions: '' });
  const second = s.createEmployee(owner.id, { name: 'PollyTalks Engineer', harness: 'claude', model: '', cwd: '', role: '', instructions: '' });
  const broker = new ConnectionBroker(s, () => 'http://localhost');
  const account = uid();
  s.run(
    'INSERT INTO connections VALUES(?,?,?,?,?,?)',
    account,
    owner.id,
    'railway',
    'railway',
    'ready',
    JSON.stringify({ tools: [] }),
  );
  s.run('INSERT INTO grants VALUES(?,?,?)', account, first.id, JSON.stringify(['read', 'write']));
  cleanup.push(async () => {
    await broker.close();
    s.close();
  });
  return { s, owner, second, broker, account };
}

describe('account sharing note', () => {
  it('appears as a step inside the reply that is in progress, not as a message trailing beneath it', () => {
    const { s, owner, second, broker, account } = fixture();
    const request = s.addMessage(second.dmId, owner.id, 'Chris', 'human', 'Summarise requests from the suspicious IP');
    const reply = s.addMessage(second.dmId, second.id, second.name, 'agent', 'Checking the logs. ', null, [], null);
    const runId = uid();
    s.run(
      'INSERT INTO runs(id,conversation_id,thread_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      runId, second.dmId, null, owner.id, second.id, request.id, reply.id, 'running', new Date().toISOString(), new Date().toISOString(), 'k',
    );
    const run = { id: runId, user_id: owner.id, employee_id: second.id, conversation_id: second.dmId, message_id: request.id };
    expect(broker.request(run, 'railway', 'read')).toMatchObject({ sharedAutomatically: true, connectionId: account });
    expect(s.all("SELECT * FROM messages WHERE conversation_id=? AND kind='system'", second.dmId)).toHaveLength(0);
    const steps = s.all('SELECT * FROM activities WHERE run_id=?', runId).map((a: any) => ({ rowId: a.id, ...JSON.parse(a.data) }));
    expect(steps).toEqual([
      expect.objectContaining({
        rowId: `${runId}:connection-shared-${account}`,
        id: `${runId}:connection-shared-${account}`,
        title: 'Using your Railway account',
        textOffset: 'Checking the logs. '.length,
      }),
    ]);
    // Asking again adds nothing.
    broker.request({ ...run, id: uid() }, 'railway', 'read');
    expect(s.all('SELECT * FROM activities')).toHaveLength(1);
  });

  it('adds nothing when no reply is in progress: the approval card is where the human learns of changes', () => {
    const { s, owner, second, broker } = fixture();
    broker.request({ id: uid(), user_id: owner.id, employee_id: second.id, conversation_id: second.dmId, message_id: uid() }, 'railway', 'read');
    expect(s.all("SELECT text FROM messages WHERE conversation_id=? AND kind='system'", second.dmId)).toEqual([]);
  });
});
