import { Harness, type ProviderInfo } from '../../../packages/contracts/src/index.js';
import type { Store } from './store.js';

const SETTING = 'providers.default';
const ORDER: Harness[] = ['codex', 'claude', 'opencode'];

/** The saved workspace default, if it names a known provider. */
export function savedDefaultProvider(store: Store): Harness | null {
  const parsed = Harness.safeParse(store.setting(SETTING, null));
  return parsed.success ? parsed.data : null;
}

/**
 * The provider new employees start with. A saved choice wins while it is still
 * connected; otherwise the first connected provider; otherwise the saved
 * choice (or Codex) so the form always has a sensible preselection.
 */
export function defaultProvider(store: Store, infos: ProviderInfo[]): Harness {
  const saved = savedDefaultProvider(store);
  const connected = (harness: Harness) => infos.find((p) => p.harness === harness)?.authenticated === true;
  if (saved && connected(saved)) return saved;
  return ORDER.find(connected) || saved || 'codex';
}

export function saveDefaultProvider(store: Store, harness: Harness) {
  store.set(SETTING, harness);
}

/** Record the first provider a workspace connects so later changes are explicit. */
export function rememberFirstProvider(store: Store, harness: Harness) {
  if (!savedDefaultProvider(store)) saveDefaultProvider(store, harness);
}
