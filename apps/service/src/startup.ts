import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
export function startupInfo() {
  const supported =
    process.platform === 'win32' &&
    existsSync(
      join(
        process.env.LOCALAPPDATA || '',
        'Programs',
        'AgentWorkspace',
        'Background Workspace.ps1',
      ),
    );
  const link = join(
    process.env.APPDATA || '',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'Agent Workspace.lnk',
  );
  return { supported, enabled: supported && existsSync(link) };
}
export async function setStartup(enabled: boolean) {
  if (!startupInfo().supported)
    throw new Error('Start-on-login is available in the installed Windows build.');
  const body = {
    enabled,
    script: join(process.env.LOCALAPPDATA!, 'Programs', 'AgentWorkspace', 'Background Workspace.ps1'),
  };
  const code = `$data=[Console]::In.ReadToEnd()|ConvertFrom-Json; $link=Join-Path ([Environment]::GetFolderPath('Startup')) 'Agent Workspace.lnk'; if($data.enabled){$shell=New-Object -ComObject WScript.Shell;$s=$shell.CreateShortcut($link);$s.TargetPath=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';$s.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$data.script+'"';$s.WindowStyle=7;$s.Save()}elseif(Test-Path -LiteralPath $link){Remove-Item -LiteralPath $link}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();
    child.on('error', reject);
    child.on('exit', (c) =>
      c === 0 ? resolve() : reject(new Error('Could not update Windows startup shortcut.')),
    );
    child.stdin.end(JSON.stringify(body));
  });
  return startupInfo();
}
