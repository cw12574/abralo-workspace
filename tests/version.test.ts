import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { APP_VERSION } from '../apps/service/src/version';

it('reports the same version as package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(APP_VERSION).toBe(pkg.version);
  expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
