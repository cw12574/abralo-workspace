// Assemble an existing draft from an already-successful native build.
// Never rebuild binaries, replace differing assets, create tags, or publish.
import { execFileSync } from 'node:child_process';
import { createReadStream, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.BUILD_RUN;
const source = process.env.SOURCE_SHA;
const tag = process.env.RELEASE_TAG;
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repo || '') ||
  !/^\d+$/.test(runId || '') ||
  !/^[a-f0-9]{40}$/.test(source || '') ||
  !/^v\d+\.\d+\.\d+-[\w.-]+$/.test(tag || '')
)
  throw new Error('Expected repository, build ID, exact commit and preview tag.');
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 10_000_000 });
const api = (path) => JSON.parse(gh('api', `repos/${repo}/${path}`));
const run = api(`actions/runs/${runId}`);
if (
  run.status !== 'completed' ||
  run.conclusion !== 'success' ||
  run.head_sha !== source ||
  run.head_repository?.full_name !== repo ||
  run.path !== '.github/workflows/build.yml'
)
  throw new Error(
    'The selected run is not a successful native build of this source in this repository.',
  );
const jobs = api(`actions/runs/${runId}/jobs?per_page=100`).jobs;
const targets = {
  'windows-x64': ['win32', 'x64'],
  'linux-x64': ['linux', 'x64'],
  'macos-x64': ['darwin', 'x64'],
  'macos-arm64': ['darwin', 'arm64'],
};
for (const target of Object.keys(targets)) {
  if (!jobs.some((job) => job.name === target && job.conclusion === 'success'))
    throw new Error(`Missing successful native job: ${target}`);
}
const releases = api('releases?per_page=100');
const release = releases.find((item) => item.tag_name === tag);
if (!release) throw new Error('Create the reviewable draft release first.');
function checkDraft() {
  const current = api(`releases/${release.id}`);
  if (!current.draft || current.target_commitish !== source || current.tag_name !== tag)
    throw new Error('Destination must remain an unpublished draft targeting the checked source.');
}
checkDraft();
if (process.argv[2] === 'validate') {
  console.log(JSON.stringify({ status: 'validated', source, runId, draft: release.id }));
} else if (process.argv[2] === 'upload') {
  const files = [];
  function collect(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile() && entry.name.endsWith('.tar.gz')) files.push(path);
      else throw new Error('Unexpected artifact content: ' + path);
    }
  }
  collect('verified-packages');
  if (files.length !== 4) throw new Error('Expected exactly four native archives.');
  async function digest(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  }
  const verified = [];
  for (const [target, [platform, arch]] of Object.entries(targets)) {
    const name = `abralo-${target}.tar.gz`;
    const matches = files.filter((path) => path.split(/[\\/]/).at(-1) === name);
    if (matches.length !== 1) throw new Error('Missing or duplicate archive: ' + name);
    const path = matches[0];
    const size = statSync(path).size;
    if (size >= 2 * 1024 ** 3) throw new Error('Archive exceeds release asset size limit.');
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', path, './release.json'], { encoding: 'utf8' }),
    );
    if (
      manifest.version !== tag.slice(1) ||
      manifest.platform !== platform ||
      manifest.arch !== arch
    )
      throw new Error('Archive manifest does not match the preview target.');
    verified.push({ name, path, size, sha256: await digest(path) });
  }
  verified.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync('SHA256SUMS', verified.map((file) => `${file.sha256}  ${file.name}\n`).join(''));
  const uploads = [
    ...verified,
    {
      name: 'SHA256SUMS',
      path: 'SHA256SUMS',
      size: statSync('SHA256SUMS').size,
      sha256: await digest('SHA256SUMS'),
    },
  ];
  for (const file of uploads) {
    checkDraft();
    let asset = api(`releases/${release.id}/assets?per_page=100`).find(
      (item) => item.name === file.name,
    );
    if (!asset) {
      gh('release', 'upload', tag, file.path, '--repo', repo);
      asset = api(`releases/${release.id}/assets?per_page=100`).find(
        (item) => item.name === file.name,
      );
    }
    if (
      asset?.state !== 'uploaded' ||
      asset.size !== file.size ||
      asset.digest !== `sha256:${file.sha256}`
    )
      throw new Error('Remote asset differs; refusing to replace it: ' + file.name);
    console.log(
      JSON.stringify({ asset: file.name, bytes: file.size, sha256: file.sha256, verified: true }),
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Four verified archives and SHA256SUMS are in draft release ${tag}. It remains unpublished.\n\nSource: ${source}\nBuild run: ${runId}\n`,
    );
} else {
  throw new Error('Usage: assemble-preview.mjs validate|upload');
}
