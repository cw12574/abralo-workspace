import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../apps/service/src/adapters/codex.js';
import { ClaudeAdapter } from '../apps/service/src/adapters/claude.js';
import { OpenCodeAdapter } from '../apps/service/src/adapters/opencode.js';
import type { Employee } from '../packages/contracts/src/index.js';
const names = process.argv.slice(2);
const adapters = {
  codex: new CodexAdapter(),
  claude: new ClaudeAdapter(),
  opencode: new OpenCodeAdapter(),
};
for (const [name, adapter] of Object.entries(adapters)) {
  if (names.length && !names.includes(name)) continue;
  const cwd = mkdtempSync(join(tmpdir(), 'workspace-live-'));
  writeFileSync(join(cwd, 'probe.txt'), 'The verification code is LANTERN-42.');
  let text = '',
    session = '',
    tools = 0;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const info = await adapter.info();
    console.log(
      JSON.stringify({
        harness: name,
        installed: info.installed,
        authenticated: info.authenticated,
        modelCount: info.models?.length,
        detail: info.detail,
      }),
    );
    if (!info.authenticated) {
      process.exitCode = 1;
      console.log(
        JSON.stringify({ harness: name, status: 'blocked: sign-in or provider required' }),
      );
      continue;
    }
    await adapter.run({
      id: crypto.randomUUID(),
      employee: {
        id: 'probe',
        ownerId: 'probe',
        dmId: 'probe',
        name: 'Verification',
        kind: 'agent',
        harness: name,
        model: '',
        cwd,
        role: '',
        instructions:
          'Only read the provided verification file. Do not change files or use external services.',
        createdAt: new Date().toISOString(),
      } as Employee,
      prompt:
        'Read probe.txt in the working directory and respond with only its verification code.',
      attachments: [],
      signal: controller.signal,
      emit: (e) => {
        if (e.type === 'text') text += e.text;
        if (e.type === 'session') session = e.data.id;
        if (e.type === 'activity') tools++;
      },
      decide: async () => ({ allow: false }),
    });
    if (!text.includes('LANTERN-42')) process.exitCode = 1;
    console.log(
      JSON.stringify({
        harness: name,
        status: text.includes('LANTERN-42') ? 'passed' : 'failed',
        durationMs: Date.now() - started,
        tools,
        sessionCreated: !!session,
        response: text.slice(0, 200),
      }),
    );
  } catch (e) {
    console.log(JSON.stringify({ harness: name, status: 'failed', error: String(e) }));
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    await adapter.dispose();
  }
}
