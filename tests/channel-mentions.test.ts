import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now, mentionsChannel } from '../apps/service/src/store.js';

it('matches exact channel mentions, not prefixes or email addresses', () => {
  expect(mentionsChannel('Hello @Team, please report in.', 'team')).toBe(true);
  expect(mentionsChannel("Let's plan in #PollyTalks.", 'pollytalks')).toBe(true);
  expect(mentionsChannel('@release.v2 go', 'release.v2')).toBe(true);
  expect(mentionsChannel('#release.v2 go', 'release.v2')).toBe(true);
  expect(mentionsChannel('@releaseXv2 go', 'release.v2')).toBe(false);
  for (const text of ['@teamwork', '@team-other', 'mail@team.com', '@@team', '##team'])
    expect(mentionsChannel(text, 'team')).toBe(false);
});

it('queues every channel agent exactly once, respects membership and keeps thread context', () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-broadcast-')));
  try {
    const u = s.createOwner('Owner');
    const agents = ['Chief of Staff', 'Builder', 'Researcher'].map((name) =>
      s.createEmployee(u.id, {
        name,
        harness: 'codex',
        model: '',
        cwd: '',
        instructions: '',
        role: '',
      }),
    );
    const team = s.setting('workspace.team');
    const input = {
      key: uid(),
      text: '@team please check in',
      recipients: [agents[0].id],
      attachments: [],
    };
    const m = s.accept(u, team, input);
    s.accept(u, team, input);
    expect(
      s
        .all('SELECT employee_id FROM outbox WHERE message_id=?', m.id)
        .map((r) => r.employee_id)
        .sort(),
    ).toEqual(agents.map((e) => e.id).sort());
    const roomCall = s.accept(u, team, {
      key: uid(),
      text: "Okay #team, let's come up with a plan.",
      recipients: [],
      attachments: [],
    });
    expect(s.all('SELECT employee_id FROM outbox WHERE message_id=?', roomCall.id)).toEqual([
      { employee_id: agents[0].id },
    ]);
    const unifiedPlan = s.accept(u, team, {
      key: uid(),
      text: '@Chief of Staff @Builder @Researcher, please come up with one plan together.',
      recipients: [agents[0].id, agents[1].id, agents[2].id],
      attachments: [],
    });
    expect(s.all('SELECT employee_id FROM outbox WHERE message_id=?', unifiedPlan.id)).toEqual(
      expect.arrayContaining(agents.map((agent) => ({ employee_id: agent.id }))),
    );
    expect(s.all('SELECT employee_id FROM outbox WHERE message_id=?', unifiedPlan.id)).toHaveLength(
      3,
    );
    const mentionJobs = s.all('SELECT id FROM outbox WHERE message_id=?', unifiedPlan.id);
    expect(mentionJobs.every((job) => s.setting('outbox.mention.' + job.id) === true)).toBe(true);
    expect(s.setting('message.planCollaboration.' + unifiedPlan.id)).toBeNull();
    const channel = uid();
    s.run(
      'INSERT INTO conversations VALUES(?,?,?,?,?)',
      channel,
      'project',
      'channel',
      null,
      now(),
    );
    s.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', channel, u.id);
    s.run('INSERT INTO employee_conversations VALUES(?,?)', agents[1].id, channel);
    const root = s.addMessage(channel, u.id, u.name, 'human', 'Work here');
    const reply = s.accept(u, channel, {
      key: uid(),
      text: '#project, review this',
      threadId: root.id,
      recipients: [],
      attachments: [],
    });
    expect(reply.threadId).toBe(root.id);
    expect(s.all('SELECT employee_id FROM outbox WHERE message_id=?', reply.id)).toEqual([
      { employee_id: agents[1].id },
    ]);
    const dm = s.accept(u, agents[0].dmId, {
      key: uid(),
      text: '@team hello',
      recipients: [],
      attachments: [],
    });
    expect(s.all('SELECT employee_id FROM outbox WHERE message_id=?', dm.id)).toEqual([
      { employee_id: agents[0].id },
    ]);
  } finally {
    s.close();
  }
});
