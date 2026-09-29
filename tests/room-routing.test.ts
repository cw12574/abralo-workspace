import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { collaborationRoom, mentionedEmployees } from '../apps/service/src/room-routing.js';

it('routes DM collaboration to the room named in the private request without copying that request', () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-room-routing-')));
  try {
    const user = s.createOwner('Chris');
    const chief = s.createEmployee(user.id, { name: 'Chief of Staff', harness: 'codex' });
    const growth = s.createEmployee(user.id, { name: 'PollyTalks Growth', harness: 'codex' });
    const engineer = s.createEmployee(user.id, { name: 'PollyTalks Engineer', harness: 'codex' });
    const room = uid();
    s.run(
      'INSERT INTO conversations VALUES(?,?,?,?,?)',
      room,
      'PollyTalks',
      'channel',
      null,
      new Date().toISOString(),
    );
    for (const employee of [chief, growth, engineer])
      s.run('INSERT INTO employee_conversations VALUES(?,?)', employee.id, room);
    const request = s.addMessage(
      chief.dmId,
      user.id,
      user.name,
      'human',
      'Okay #PollyTalks, let us make one shared revenue plan.',
      null,
    );
    const run = {
      id: uid(),
      message_id: request.id,
      employee_id: chief.id,
      conversation_id: chief.dmId,
      user_id: user.id,
    };

    expect(
      collaborationRoom(s, run, '@PollyTalks Growth — review the plan and send pricing evidence.'),
    ).toBe(room);
    expect(
      mentionedEmployees(
        s,
        user.id,
        '@PollyTalks Growth and @PollyTalks Engineer — review this.',
      ).map((employee) => employee.id),
    ).toEqual([growth.id, engineer.id]);
    expect(s.messages(room)).toHaveLength(0);
  } finally {
    s.close();
  }
});

it('falls back to the shared Team room when no project room matches', () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-room-routing-')));
  try {
    const user = s.createOwner('Chris');
    const chief = s.createEmployee(user.id, { name: 'Chief of Staff', harness: 'codex' });
    const request = s.addMessage(
      chief.dmId,
      user.id,
      user.name,
      'human',
      'Please review this.',
      null,
    );
    expect(
      collaborationRoom(
        s,
        {
          id: uid(),
          message_id: request.id,
          employee_id: chief.id,
          conversation_id: chief.dmId,
          user_id: user.id,
        },
        '@Chief of Staff — please review this unrelated item.',
      ),
    ).toBe(s.setting('workspace.team'));
  } finally {
    s.close();
  }
});
