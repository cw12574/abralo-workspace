import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, uid, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

it('backs up and restores messages and attachments without restoring live credentials or jobs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-restore-'));
  const s = new Store(join(root, 'original'));
  const u = s.createOwner('Owner');
  const e = s.createEmployee(u.id, {
    name: 'Agent',
    harness: 'codex',
    model: '',
    role: '',
    instructions: '',
    cwd: '',
  });
  const artifact = uid();
  writeFileSync(join(s.dir, 'artifacts', artifact), 'saved artifact');
  s.run(
    'INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)',
    artifact,
    u.id,
    e.dmId,
    'report.txt',
    'text/plain',
    14,
    join(s.dir, 'artifacts', artifact),
    now(),
  );
  s.addMessage(e.dmId, u.id, u.name, 'human', 'Keep this report', null, [artifact]);
  s.run(
    'INSERT INTO schedules VALUES(?,?,?,?,?,?,?,1)',
    uid(),
    u.id,
    e.dmId,
    e.id,
    'Later',
    '2099-01-01T00:00:00Z',
    60,
  );
  s.run('INSERT INTO native_sessions VALUES(?,?,?)', 'context', 'native-session', e.id);
  const { app } = await createApp(s);
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/bootstrap',
      headers: { 'x-workspace-request': '1' },
      payload: { token: s.bootstrapToken },
    });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0];
    const backup = await app.inject({
      method: 'POST',
      url: '/api/backups',
      headers: { cookie, 'x-workspace-request': '1' },
    });
    expect(backup.statusCode).toBe(200);
    const target = join(root, 'restored');
    const restore = spawnSync(
      process.execPath,
      [resolve('scripts/restore.mjs'), backup.json().path, target],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(restore.status, restore.stderr).toBe(0);
    const r = new Store(target);
    try {
      expect(r.db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(r.messages(e.dmId)[0].text).toBe('Keep this report');
      expect(
        readFileSync(r.one('SELECT path FROM attachments WHERE id=?', artifact).path, 'utf8'),
      ).toBe('saved artifact');
      expect(r.all('SELECT * FROM sessions')).toHaveLength(0);
      expect(r.all('SELECT * FROM native_sessions')).toHaveLength(0);
      expect(r.one('SELECT enabled FROM schedules').enabled).toBe(0);
      expect(r.bootstrapToken).not.toBe(s.bootstrapToken);
    } finally {
      r.close();
    }
    const overwrite = spawnSync(
      process.execPath,
      [resolve('scripts/restore.mjs'), backup.json().path, target],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(overwrite.status).not.toBe(0);
  } finally {
    await app.close();
  }
}, 30000);
