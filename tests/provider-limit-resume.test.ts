import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderLimitError } from '../apps/service/src/adapters/provider-limit.js';
import { tickSchedules } from '../apps/service/src/operations.js';
import { Store, uid } from '../apps/service/src/store.js';
import { Supervisor } from '../apps/service/src/supervisor.js';

async function waitForRuns(sup: Supervisor) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.all([...sup.inflight]);
}

describe('automatic resume after provider limits', () => {
  it('reuses the accepted request once the saved retry time arrives', async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-limit-retry-')));
    const user = store.createOwner('Owner');
    const employee = store.createEmployee(user.id, {
      name: 'Agent', harness: 'codex', model: '', role: '', instructions: '', cwd: '',
    });
    store.accept(user, employee.dmId, {
      text: 'Continue my work', key: uid(), attachments: [], recipients: [employee.id], newTask: false,
    });
    const sup = new Supervisor(store);
    let calls = 0;
    sup.adapters.codex = {
      info: async () => ({ harness: 'codex', installed: true, authenticated: true, version: 'test', detail: '' }),
      run: async (input) => {
        calls++;
        if (calls === 1) throw new ProviderLimitError('Weekly limit reached', 'Codex', 'weekly', new Date(Date.now() + 60000).toISOString());
        input.emit({ type: 'session', data: { id: 'native-session' } });
        input.emit({ type: 'text', text: 'Continued.' });
        input.emit({ type: 'final', text: 'Continued.' });
        input.emit({ type: 'complete', data: { cancelled: false } });
      },
      dispose: async () => {},
    };
    try {
      await sup.dispatch();
      await waitForRuns(sup);
      const paused = store.one('SELECT * FROM runs WHERE state=?', 'provider_limited');
      expect(paused).toBeTruthy();
      expect(store.setting('run.autoResume.' + paused.id)).toBe(true);
      expect(store.one('SELECT status FROM outbox').status).toBe('done');

      store.set('run.limit.' + paused.id, {
        provider: 'Codex', window: 'weekly', retryAt: new Date(Date.now() - 1000).toISOString(), message: 'Weekly limit reached',
      });
      tickSchedules(store, sup);
      await waitForRuns(sup);
      expect(calls).toBe(2);
      expect(store.one('SELECT state FROM runs WHERE id=?', paused.id).state).toBe('interrupted');
      expect(store.one("SELECT state FROM runs WHERE state='completed'")).toBeTruthy();
    } finally {
      await sup.dispose();
      store.close();
    }
  });

  it('does not resume after the user turns the preference off', async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-limit-off-')));
    const user = store.createOwner('Owner');
    const employee = store.createEmployee(user.id, {
      name: 'Agent', harness: 'codex', model: '', role: '', instructions: '', cwd: '',
    });
    store.accept(user, employee.dmId, {
      text: 'Continue my work', key: uid(), attachments: [], recipients: [employee.id], newTask: false,
    });
    const sup = new Supervisor(store);
    let calls = 0;
    sup.adapters.codex = {
      info: async () => ({ harness: 'codex', installed: true, authenticated: true, version: 'test', detail: '' }),
      run: async () => {
        calls++;
        throw new ProviderLimitError('Weekly limit reached', 'Codex', 'weekly', new Date(Date.now() - 1000).toISOString());
      },
      dispose: async () => {},
    };
    try {
      await sup.dispatch();
      await waitForRuns(sup);
      const paused = store.one('SELECT * FROM runs WHERE state=?', 'provider_limited');
      store.set('run.autoResume.' + paused.id, false);
      tickSchedules(store, sup);
      await waitForRuns(sup);
      expect(calls).toBe(1);
      expect(store.one('SELECT state FROM runs WHERE id=?', paused.id).state).toBe('provider_limited');
    } finally {
      await sup.dispose();
      store.close();
    }
  });
});
