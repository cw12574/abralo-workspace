import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { ComputerUse } from '../apps/service/src/computer-use.js';

const instances: ComputerUse[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map((instance) => instance.close())); });

function fixture(decide = async () => ({ allow: false })) {
  const active = new Map([['run-one', new AbortController()], ['run-two', new AbortController()]]);
  const events: any[] = [];
  const store = {
    setting: () => false,
    user: () => ({ role: 'owner' }),
    emit: (...event: any[]) => events.push(event),
  };
  const supervisor = { active, decision: decide };
  const computer = new ComputerUse(store as any, supervisor as any);
  instances.push(computer);
  const tools = (id: string) => {
    const callbacks: Record<string, (args: any) => Promise<any>> = {};
    computer.register({ registerTool: (name: string, _definition: any, callback: any) => { callbacks[name] = callback; } }, { id, user_id: 'owner' }, { name: 'Agent' });
    return callbacks;
  };
  return { computer, tools, active, events };
}

describe('computer use', () => {
  it('keeps browser pages isolated by run and returns a screenshot', async () => {
    const server = createServer((_req, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<title>Fixture</title><main><input id="memo"><button onclick="localStorage.memo=document.querySelector(\'#memo\').value;document.querySelector(\'output\').textContent=localStorage.memo">Save</button><output></output><script>document.querySelector(\'output\').textContent=localStorage.memo||\'empty\'</script></main>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('Missing fixture port');
      const { tools } = fixture();
      const first = tools('run-one').workspace_browser;
      const second = tools('run-two').workspace_browser;
      const url = `http://127.0.0.1:${address.port}`;
      expect(JSON.stringify(await first({ action: 'navigate', url }))).toContain('Fixture');
      await first({ action: 'fill', selector: '#memo', value: 'private run value' });
      await first({ action: 'click', selector: 'button' });
      expect(JSON.stringify(await first({ action: 'snapshot' }))).toContain('private run value');
      await second({ action: 'navigate', url });
      expect(JSON.stringify(await second({ action: 'snapshot' }))).toContain('empty');
      expect(JSON.stringify(await second({ action: 'snapshot' }))).not.toContain('private run value');
      const shot = await first({ action: 'screenshot' });
      expect(shot.content.some((part: any) => part.type === 'image' && part.mimeType === 'image/png')).toBe(true);
      await expect(first({ action: 'navigate', url: 'file:///C:/secret.txt' })).rejects.toThrow('http or https');
    } finally {
      server.close();
    }
  }, 30000);

  it.runIf(process.platform === 'win32')('requires explicit consent and supports immediate revocation', async () => {
    const { computer, tools, active, events } = fixture(async () => ({ allow: true }));
    const desktop = tools('run-one').workspace_desktop;
    await expect(desktop({ action: 'screenshot' })).rejects.toThrow('Request desktop control');
    const response = await desktop({ action: 'request', reason: 'Open a desktop app' });
    if (process.platform === 'win32') {
      expect(JSON.parse(response.content[0].text).active).toBe(true);
      expect(computer.status('owner').active).toBe(true);
      expect(computer.revoke('owner').active).toBe(false);
      expect(events.some((event) => event[0] === 'desktop.control' && event[2].active === false)).toBe(true);
      await expect(desktop({ action: 'screenshot' })).rejects.toThrow('Request desktop control');
      await desktop({ action: 'request' });
      active.get('run-one')!.abort();
      expect(computer.status('owner').active).toBe(false);
    } else expect(JSON.stringify(response)).toContain('requires Windows');
  });

  it.runIf(process.platform === 'win32')('keeps the desktop unavailable after a declined request', async () => {
    const { tools } = fixture();
    const desktop = tools('run-one').workspace_desktop;
    const response = await desktop({ action: 'request', reason: 'Open a desktop app' });
    expect(JSON.parse(response.content[0].text).active).toBe(false);
    await expect(desktop({ action: 'click', x: 10, y: 10 })).rejects.toThrow('Request desktop control');
  });

  it.runIf(process.platform !== 'win32')('reports desktop control as unsupported without requesting access', async () => {
    let prompted = false;
    const { tools, computer } = fixture(async () => { prompted = true; return { allow: true }; });
    const desktop = tools('run-one').workspace_desktop;
    for (const action of ['request', 'screenshot', 'click']) {
      expect(JSON.stringify(await desktop({ action }))).toContain('requires Windows');
    }
    expect(prompted).toBe(false);
    expect(computer.status().active).toBe(false);
  });
});
