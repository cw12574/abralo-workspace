import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import { ApiError, hash } from './store.js';
import type { Vault } from './vault.js';
export const gmailTools = [
  {
    name: 'gmail_list_messages',
    description: 'Search mail with Gmail query syntax; returns message IDs.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'gmail_get_message',
    description: 'Read one message by ID.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'gmail_send_message',
    description: 'Send a plain text email. Requires send scope, a write grant and human approval.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'subject', 'body'],
    },
  },
];
export class GmailConnection {
  constructor(
    public vault: Vault,
    public id: string,
    public redirect: string,
  ) {}
  client() {
    const data = this.vault.get(this.id),
      c = data.googleClient;
    if (!c) throw new ApiError(409, 'Configure a Google OAuth client first.');
    const client = new OAuth2Client({
      clientId: c.id,
      clientSecret: c.secret,
      redirectUri: this.redirect,
    });
    client.setCredentials(data.tokens || {});
    client.on('tokens', (t) => {
      const latest = this.vault.get(this.id);
      this.vault.set(this.id, { ...latest, tokens: { ...latest.tokens, ...t } });
    });
    return client;
  }
  async authorize(write = false) {
    const client = this.client(),
      state = randomBytes(32).toString('base64url'),
      pkce = await client.generateCodeVerifierAsync();
    const old = this.vault.get(this.id);
    this.vault.set(this.id, {
      ...old,
      verifier: pkce.codeVerifier,
      attempt: { stateHash: hash(state), expires: Date.now() + 600000 },
    });
    return client.generateAuthUrl({
      state,
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        ...(write ? ['https://www.googleapis.com/auth/gmail.send'] : []),
      ],
      code_challenge: pkce.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }
  async finish(code: string) {
    const client = this.client();
    const { tokens } = await client.getToken({
      code,
      codeVerifier: this.vault.get(this.id).verifier,
    });
    const old = this.vault.get(this.id);
    this.vault.set(this.id, { ...old, tokens: { ...old.tokens, ...tokens }, verifier: undefined });
    return this.profile();
  }
  async profile() {
    const { data } = await this.client().request<any>({
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    });
    return { email: data.emailAddress };
  }
  async call(name: string, args: any) {
    const client = this.client(),
      base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
    let data: any;
    if (name === 'gmail_list_messages')
      ({ data } = await client.request({
        url: base,
        params: {
          q: String(args.query || ''),
          maxResults: Math.min(50, Math.max(1, Number(args.maxResults) || 20)),
        },
      }));
    else if (name === 'gmail_get_message') {
      if (typeof args.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(args.id))
        throw new ApiError(400, 'Invalid message ID');
      ({ data } = await client.request({ url: base + '/' + args.id, params: { format: 'full' } }));
    } else if (name === 'gmail_send_message') {
      if (!/^[^\r\n<>\s]+@[^\r\n<>\s]+$/.test(args.to || ''))
        throw new ApiError(400, 'Supply one valid recipient address');
      const subject = Buffer.from(String(args.subject || '')).toString('base64');
      const raw = Buffer.from(
        `To: ${args.to}\r\nSubject: =?UTF-8?B?${subject}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(String(args.body || '')).toString('base64')}`,
      ).toString('base64url');
      ({ data } = await client.request({ url: base + '/send', method: 'POST', data: { raw } }));
    } else throw new ApiError(400, 'Unknown Gmail tool');
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
}
