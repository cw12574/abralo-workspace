import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
export class Vault {
  private constructor(
    private dir: string,
    private key: Buffer,
  ) {}
  static async open(dir: string) {
    const path = join(dir, process.platform === 'win32' ? 'vault-key.dpapi' : 'vault-key');
    let key: Buffer;
    if (existsSync(path)) {
      const raw = readFileSync(path);
      key = process.platform === 'win32' ? await dpapi(raw, false) : raw;
    } else {
      key = randomBytes(32);
      writeFileSync(path, process.platform === 'win32' ? await dpapi(key, true) : key, {
        mode: 0o600,
      });
    }
    return new Vault(dir, key);
  }
  get(id: string): any {
    const p = join(this.dir, 'secret-' + id);
    if (!existsSync(p)) return {};
    const b = readFileSync(p);
    const decipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString(),
    );
  }
  set(id: string, data: any) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    const p = join(this.dir, 'secret-' + id);
    writeFileSync(p + '.tmp', Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    renameSync(p + '.tmp', p);
  }
}
function dpapi(value: Buffer, protect: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const code = `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${protect ? 'Protect' : 'Unprotect'}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('exit', (c) =>
      c === 0
        ? resolve(Buffer.from(out, 'base64'))
        : reject(new Error('Windows credential protection failed')),
    );
    child.stdin.end(value.toString('base64'));
  });
}
