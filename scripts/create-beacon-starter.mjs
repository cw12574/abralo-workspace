#!/usr/bin/env node
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(
    'Usage: node scripts/create-beacon-starter.mjs NEW_DIRECTORY\nCreates the original brief and a workflow guide. No installs or model calls.',
  );
} else if (args.length !== 1 || args[0].startsWith('-')) {
  console.error('Provide one new directory. Use --help for details.');
  process.exitCode = 1;
} else {
  try {
    const target = resolve(args[0]);
    // Non-recursive creation rejects existing directories, including project roots.
    mkdirSync(target);
    copyFileSync(
      new URL('../examples/beacon/BRIEF.md', import.meta.url),
      join(target, 'BRIEF.md'),
      constants.COPYFILE_EXCL,
    );
    const guide = readFileSync(
      new URL('../examples/beacon/TRY-IT.md', import.meta.url),
      'utf8',
    ).replace(/\]\(([^\s)]+)\)/g, (match, href) => {
      if (/^https?:/.test(href) || href === 'BRIEF.md') return match;
      return (
        '](' +
        new URL(href, 'https://github.com/cw12574/abralo-workspace/blob/main/examples/beacon/')
          .href +
        ')'
      );
    });
    writeFileSync(join(target, 'README.md'), guide, { flag: 'wx' });
    console.log(
      `Created ${target}\nSelect this disposable folder in an Abralo room. Follow README.md. No provider calls were made.`,
    );
  } catch (error) {
    console.error(
      error.code === 'EEXIST'
        ? 'That directory already exists. Choose a new directory; nothing was overwritten.'
        : `Could not create starter: ${error.message}`,
    );
    process.exitCode = 1;
  }
}
