/**
 * Finds a remote MCP server for a service the human (or an agent) names.
 * Sources, most trusted first:
 *  1. Services Abralo has checked.
 *  2. The service's own website: /.well-known/mcp.json or an MCP server card.
 *  3. The official MCP Registry, where a reverse-DNS name (com.resend/...) is
 *     namespace-verified by the registry. Other publishers are shown as third party.
 * Nothing here connects or sends credentials; it only describes candidates.
 */
export type ServiceCandidate = {
  slug: string;
  label: string;
  url: string;
  auth: 'oauth' | 'api_key' | 'unknown';
  /** Who runs the server, e.g. "resend.com". */
  publisher: string;
  /** True when the server is run by the service itself, not a relay. */
  official: boolean;
  source: 'built-in' | 'website' | 'registry' | 'address';
  description?: string;
  apiKeyHelp?: string;
};

export const builtInServices: Record<string, ServiceCandidate> = {
  stripe: {
    slug: 'stripe',
    label: 'Stripe',
    url: 'https://mcp.stripe.com',
    auth: 'oauth',
    publisher: 'stripe.com',
    official: true,
    source: 'built-in',
  },
  railway: {
    slug: 'railway',
    label: 'Railway',
    url: 'https://mcp.railway.com',
    auth: 'oauth',
    publisher: 'railway.com',
    official: true,
    source: 'built-in',
  },
  resend: {
    slug: 'resend',
    label: 'Resend',
    url: 'https://mcp.resend.com/mcp',
    auth: 'oauth',
    publisher: 'resend.com',
    official: true,
    source: 'built-in',
    description: 'Email API: send email, manage domains, contacts and broadcasts.',
    apiKeyHelp: 'Create an API key at https://resend.com/api-keys',
  },
};
/** Gmail is a dedicated integration, not a remote MCP server. */
export const integrationServices = new Set(['gmail']);

type Fetch = typeof fetch;
export type DiscoveryOptions = {
  fetch?: Fetch;
  registry?: string;
  /** Tests only: allow http and local hosts for a stand-in service. */
  allowLocal?: boolean;
  timeoutMs?: number;
};

const registryDefault = 'https://registry.modelcontextprotocol.io';
const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'service';
/** The registrable part of a host, good enough for publisher display: mcp.resend.com → resend.com. */
export function siteOf(host: string) {
  if (/^[\d.]+(:\d+)?$/.test(host) || host.includes('[')) return host;
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  const twoPart = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoPart ? -3 : -2).join('.');
}

export function safeServerUrl(raw: string, allowLocal = false) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:')) return null;
  const host = url.hostname.toLowerCase();
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(':');
  if (local && !allowLocal) return null;
  return url;
}

async function getJson(url: string, options: DiscoveryOptions) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
  try {
    const response = await (options.fetch || fetch)(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 512 * 1024) return null;
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a website's own description: Resend-style mcp.json or an MCP server card. */
function fromWebsite(site: string, doc: any, options: DiscoveryOptions): ServiceCandidate | null {
  const remote =
    doc?.remote ||
    (Array.isArray(doc?.remotes) ? doc.remotes.find((r: any) => /http/i.test(r?.type || r?.transport || 'streamable-http')) : null);
  const url = safeServerUrl(String(remote?.url || ''), options.allowLocal);
  if (!url) return null;
  const auth = remote?.authentication || remote?.auth || {};
  const type = String(auth.type || '').toLowerCase();
  const label = String(doc.name || doc.title || site).slice(0, 80);
  return {
    slug: slugify(label),
    label,
    url: url.href,
    auth: type.startsWith('oauth') ? 'oauth' : /key|bearer|token/.test(type) ? 'api_key' : 'unknown',
    publisher: site,
    // Served from the service's own domain, pointing at its own domain.
    official: siteOf(url.hostname) === siteOf(site),
    source: 'website',
    description: typeof doc.description === 'string' ? doc.description.slice(0, 300) : undefined,
    apiKeyHelp:
      typeof auth.api_key?.description === 'string'
        ? auth.api_key.description.slice(0, 300)
        : undefined,
  };
}

async function websiteCandidates(site: string, options: DiscoveryOptions) {
  const base = options.allowLocal && /^http:\/\//.test(site) ? site : `https://${site}`;
  const host = new URL(base).host;
  const docs = await Promise.all(
    ['/.well-known/mcp.json', '/.well-known/mcp/server-card.json'].map((path) =>
      getJson(base.replace(/\/$/, '') + path, options),
    ),
  );
  return docs.map((doc) => (doc ? fromWebsite(host, doc, options) : null)).filter(Boolean) as ServiceCandidate[];
}

async function registryCandidates(query: string, options: DiscoveryOptions) {
  const base = options.registry || registryDefault;
  const data = await getJson(
    `${base}/v0.1/servers?search=${encodeURIComponent(query)}&version=latest&limit=20`,
    options,
  );
  const found: ServiceCandidate[] = [];
  for (const entry of data?.servers || []) {
    const server = entry?.server;
    const status = entry?._meta?.['io.modelcontextprotocol.registry/official']?.status;
    if (!server || (status && status !== 'active')) continue;
    for (const remote of server.remotes || []) {
      if (remote?.type !== 'streamable-http') continue;
      const url = safeServerUrl(String(remote.url || ''), options.allowLocal);
      if (!url) continue;
      // Registry names like com.resend/mcp are verified against the domain resend.com.
      const namespace = String(server.name || '').split('/')[0];
      const domain = namespace.includes('.') ? namespace.split('.').reverse().join('.') : '';
      const publisher = siteOf(url.hostname);
      let label = String(server.title || server.name || publisher).split('/').pop()!.slice(0, 80);
      // Names like com.notion/mcp say nothing; use the publisher instead.
      if (/^(mcp|server|remote|mcp-server|api)$/i.test(label)) label = publisher.split('.')[0];
      found.push({
        slug: slugify(label),
        label: label.charAt(0).toUpperCase() + label.slice(1),
        url: url.href,
        auth: 'unknown',
        publisher,
        official: !!domain && siteOf(domain) === publisher,
        source: 'registry',
        description: typeof server.description === 'string' ? server.description.slice(0, 300) : undefined,
      });
    }
  }
  return found;
}

/**
 * Best candidates first: Abralo-checked, then official (run by the service
 * itself), then third-party relays. Each server address appears once.
 */
export async function discoverServices(query: string, options: DiscoveryOptions = {}) {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  const lower = q.toLowerCase();
  const results: ServiceCandidate[] = [];
  const builtIn = Object.values(builtInServices).filter(
    (s) => s.slug === slugify(lower) || s.label.toLowerCase() === lower || lower.includes(s.publisher),
  );
  results.push(...builtIn);
  const tasks: Promise<ServiceCandidate[]>[] = [];
  const address = /^https?:\/\//i.test(q) ? safeServerUrl(q, options.allowLocal) : null;
  if (address) {
    // A pasted server address: use it as given, and read its site's description if any.
    results.push({
      slug: slugify(address.hostname),
      label: siteOf(address.hostname),
      url: address.href,
      auth: 'unknown',
      publisher: siteOf(address.hostname),
      official: false,
      source: 'address',
    });
    tasks.push(websiteCandidates(options.allowLocal ? address.origin : siteOf(address.hostname), options));
  } else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(q)) {
    tasks.push(websiteCandidates(q.toLowerCase(), options));
    tasks.push(registryCandidates(q.split('.')[0], options));
  } else {
    // A name: try the service's likely website as well as the registry.
    if (/^[a-z0-9-]+$/i.test(q)) tasks.push(websiteCandidates(`${lower}.com`, options));
    tasks.push(registryCandidates(q, options));
  }
  for (const list of await Promise.all(tasks)) results.push(...list);
  // "Official" means run by the service that was asked for, not merely a verified publisher.
  const wanted = (address ? siteOf(address.hostname) : lower).split('.')[0].replace(/[^a-z0-9]/g, '');
  const firstLabel = (site: string) => site.split('.')[0].replace(/[^a-z0-9]/g, '');
  const word = new RegExp(`(^|[^a-z0-9])${wanted.replace(/[^a-z0-9]/g, '')}`, 'i');
  for (const c of results)
    // A site's own description of its own server is official as published; others must match the request.
    if (!(c.source === 'website' && c.official))
      c.official = c.source === 'built-in' || firstLabel(c.publisher) === wanted;
  const rank = (c: ServiceCandidate) =>
    (c.source === 'built-in' ? 0 : c.source === 'website' ? 1 : c.official ? 2 : c.source === 'address' ? 3 : 4) * 10;
  const seen = new Set<string>();
  return results
    // Drop registry noise such as "Presend" for "resend".
    .filter((c) => c.source !== 'registry' || c.official || word.test(c.label) || word.test(c.publisher))
    .sort((a, b) => rank(a) - rank(b))
    .filter((c) => {
      const key = c.url.replace(/\/$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}
