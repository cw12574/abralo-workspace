#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const repository = 'cw12574/abralo-workspace';
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const pinnedReleases = JSON.parse(
  readFileSync(new URL('../releases.json', import.meta.url), 'utf8'),
);
const targets = new Map([
  ['win32:x64', 'windows-x64'],
  ['darwin:x64', 'macos-x64'],
  ['darwin:arm64', 'macos-arm64'],
  ['linux:x64', 'linux-x64'],
]);

function usage() {
  console.log(
    `Abralo ${packageJson.version}\n\nDownloads and installs the matching Abralo preview release.\n\nUsage: abralo [--help|--version]`,
  );
}

async function get(url, accept = 'application/vnd.github+json') {
  const response = await fetch(url, {
    headers: { accept, 'user-agent': 'abralo-npm-installer' },
    redirect: 'follow',
  });
  if (!response.ok)
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  return response;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return usage();
  if (args.length === 1 && args[0] === '--version') return console.log(packageJson.version);
  if (args.length) throw new Error(`Unknown option: ${args[0]} (use --help)`);

  const target = targets.get(`${process.platform}:${process.arch}`);
  if (!target)
    throw new Error(`No preview package is available for ${process.platform}/${process.arch}.`);
  const tag = `v${packageJson.version}`;
  const api = `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  const release = await (await get(api)).json();
  if (release.tag_name !== tag) throw new Error(`GitHub returned the wrong release for ${tag}.`);

  const archiveName = `abralo-${target}.tar.gz`;
  const archiveAsset = release.assets?.find((asset) => asset.name === archiveName);
  if (!archiveAsset)
    throw new Error(
      `Release ${tag} is missing ${archiveName}. Ask the maintainer to finish the release.`,
    );
  const expected = pinnedReleases[packageJson.version]?.[archiveName];
  if (!/^[a-f0-9]{64}$/i.test(expected || ''))
    throw new Error(
      `The installer package has no pinned SHA-256 for ${archiveName}. Ask the maintainer to update it before publishing.`,
    );

  const scratch = mkdtempSync(join(tmpdir(), 'abralo-install-'));
  try {
    const archivePath = join(scratch, archiveName);
    const archiveResponse = await get(
      archiveAsset.browser_download_url,
      'application/octet-stream',
    );
    if (!archiveResponse.body)
      throw new Error(`GitHub returned an empty download for ${archiveName}.`);
    const digest = createHash('sha256');
    await pipeline(
      Readable.fromWeb(archiveResponse.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          digest.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(archivePath, { flags: 'wx' }),
    );
    const actual = digest.digest('hex');
    if (actual.toLowerCase() !== expected.toLowerCase())
      throw new Error(`SHA-256 mismatch for ${archiveName}; nothing was installed.`);

    const packagePath = join(scratch, 'package');
    mkdirSync(packagePath);
    const extract = spawnSync('tar', ['-xzf', archivePath, '-C', packagePath], {
      cwd: scratch,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (extract.error) throw extract.error;
    if (extract.status !== 0)
      throw new Error(
        (extract.stderr || extract.stdout || 'Could not extract the release archive.').trim(),
      );

    const releaseJson = JSON.parse(readFileSync(join(packagePath, 'release.json'), 'utf8'));
    if (releaseJson.platform !== process.platform || releaseJson.arch !== process.arch)
      throw new Error(
        `Release target mismatch: package is ${releaseJson.platform}/${releaseJson.arch}, this machine is ${process.platform}/${process.arch}.`,
      );

    console.log(`Verified Abralo ${packageJson.version} for ${target}. Installing...`);
    const result =
      process.platform === 'win32'
        ? spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-File',
              join(packagePath, 'scripts', 'install-windows.ps1'),
              '-ReleaseDirectory',
              packagePath,
            ],
            { cwd: packagePath, stdio: 'inherit', windowsHide: true },
          )
        : spawnSync(
            join(packagePath, 'runtime', 'node'),
            [join(packagePath, 'scripts', 'install-posix.mjs')],
            { cwd: packagePath, stdio: 'inherit', windowsHide: true },
          );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Abralo installer: ${error.message}`);
  process.exitCode = 1;
});
