import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { baseUrl, opt } from './config.js';
import { db } from './db.js';
import { allow } from './ratelimit.js';
import { isUuid, safeEqual } from './util.js';

/**
 * OAuth 2.1 authorization server for MCP (spec 2025-06-18 and newer):
 *  - RFC 9728 protected resource metadata, RFC 8414 authorization server metadata
 *  - RFC 7591 dynamic client registration (public clients only)
 *  - authorization code + PKCE (S256 only), RFC 8707 `resource` check, RFC 9207 `iss` in the redirect
 * There is no Google / GitHub login: the consent page signs the user in as ONE shared demo account (DEMO_USER_ID).
 * This server issues its own opaque tokens.
 * Codes, access tokens and refresh tokens are stored only as SHA-256 hashes. Secrets are never logged.
 */

export const ACCESS_PREFIX = 'mcp_at_';
const REFRESH_PREFIX = 'mcp_rt_';
const ACCESS_TTL_S = 60 * 60; // 1 hour
const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_S = 5 * 60; // 5 minutes
const GRANTS = ['authorization_code', 'refresh_token'];
const WEB_CLIENT = 'ai-shop-web';
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---------- small helpers ----------
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const secret = (prefix = ''): string => prefix + randomBytes(32).toString('base64url');
const str = (v: unknown): string => (typeof v === 'string' ? v : ''); // arrays / objects become '' (rejected)
const asObj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});
const resourceUrl = (): string => `${baseUrl()}/mcp`;
export const resourceMetadataUrl = (): string => `${baseUrl()}/.well-known/oauth-protected-resource`;
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** RFC 8707: if the client sends `resource`, it must be this MCP server (trailing slash tolerated). */
const resourceOk = (r: string): boolean => r === '' || r.replace(/\/+$/, '') === resourceUrl();

function noStore(res: Response): void {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
}
function oauthError(res: Response, status: number, error: string, description: string): void {
  noStore(res);
  res.status(status).json({ error, error_description: description });
}
const ah =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res) => {
    fn(req, res).catch((e: unknown) => {
      console.error('oauth error:', e instanceof Error ? e.message : 'unknown'); // message only, never request data
      if (!res.headersSent) oauthError(res, 500, 'server_error', 'Internal error');
    });
  };
/** 20 requests per minute per IP, per endpoint. */
const limited =
  (name: string): RequestHandler =>
  (req, res, next) => {
    if (allow(`oauth:${name}:${req.ip ?? 'unknown'}`, 20)) return next();
    res.set('Retry-After', '60');
    oauthError(res, 429, 'too_many_requests', 'Too many requests. Try again in a minute.');
  };

// ---------- redirect URI rules ----------
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'about', 'ftp', 'ws', 'wss']);

/** https, or http only on localhost / 127.0.0.1, or a custom app scheme. No fragments, no credentials. */
function isValidRedirectUri(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(s) || s.includes('#')) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'https') return u.hostname.length > 0;
  if (scheme === 'http') return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (BLOCKED_SCHEMES.has(scheme)) return false;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme); // custom app scheme, e.g. claude://
}

/** Adds params to a validated redirect URI. `iss` is RFC 9207 (also sent on errors). */
function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set('iss', baseUrl());
  return u.toString();
}

// ---------- clients ----------
interface Client {
  client_id: string;
  redirect_uris: string[];
  client_name: string;
}
async function getClient(clientId: string): Promise<Client | null> {
  if (!clientId || clientId.length > 200) return null;
  const { data, error } = await db.from('oauth_clients').select('client_id, redirect_uris, client_name').eq('client_id', clientId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Client | null) ?? null;
}

// ---------- authorization request validation (shared by /authorize, /oauth/approve, /oauth/deny) ----------
interface AuthReq {
  client: Client;
  redirect_uri: string;
  code_challenge: string;
  state: string;
}
type AuthCheck =
  | { ok: true; v: AuthReq }
  // fatal = the redirect_uri cannot be trusted, so show an error page instead of redirecting
  | { ok: false; fatal: boolean; redirectUri?: string; state?: string; error: string; description: string };

async function validateAuthRequest(p: Record<string, unknown>): Promise<AuthCheck> {
  const client = await getClient(str(p.client_id));
  if (!client) return { ok: false, fatal: true, error: 'invalid_client', description: 'Unknown client_id.' };
  const redirectUri = str(p.redirect_uri);
  if (!client.redirect_uris.includes(redirectUri)) {
    return { ok: false, fatal: true, error: 'invalid_request', description: 'redirect_uri does not exactly match a registered redirect URI.' };
  }
  const state = str(p.state);
  const fail = (error: string, description: string): AuthCheck => ({ ok: false, fatal: false, redirectUri, state: state || undefined, error, description });
  if (str(p.response_type) !== 'code') return fail('unsupported_response_type', 'response_type must be "code".');
  if (!state || state.length > 512) return fail('invalid_request', 'state is required (max 512 characters).');
  if (str(p.code_challenge_method) !== 'S256') return fail('invalid_request', 'PKCE is required: code_challenge_method must be S256.');
  const challenge = str(p.code_challenge);
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('invalid_request', 'code_challenge must be a base64url SHA-256 value (43 characters).');
  if (!resourceOk(str(p.resource))) return fail('invalid_target', 'resource must be the MCP server URL.');
  return { ok: true, v: { client, redirect_uri: redirectUri, code_challenge: challenge, state } };
}

// ---------- tokens ----------
async function issueTokens(userId: string, clientId: string): Promise<Record<string, unknown>> {
  const access = secret(ACCESS_PREFIX);
  const refresh = secret(REFRESH_PREFIX);
  const now = Date.now();
  const { error } = await db.from('oauth_tokens').insert({
    token_hash: sha256hex(access),
    refresh_hash: sha256hex(refresh),
    client_id: clientId,
    user_id: userId,
    expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString(),
    refresh_expires_at: new Date(now + REFRESH_TTL_S * 1000).toISOString(),
    revoked: false,
  });
  if (error) throw new Error(error.message);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh };
}

/** Used by the auth middleware. Returns the user id, or null if unknown / expired / revoked. Throws on DB failure. */
export async function verifyAccessToken(token: string): Promise<{ id: string } | null> {
  const { data, error } = await db.from('oauth_tokens').select('user_id, expires_at, revoked').eq('token_hash', sha256hex(token)).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.revoked || new Date(data.expires_at as string).getTime() <= Date.now()) return null;
  return { id: data.user_id as string };
}

// ---------- CORS (for /.well-known, /register, /token; no cookies are used, so * is safe) ----------
export const oauthCors: RequestHandler = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return void res.status(204).end();
  next();
};

// ---------- HTML pages ----------
/** Headers for pages that show the consent screen: no framing (clickjacking), no referrer, strict CSP. */
function pageHeaders(res: Response): void {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': ["default-src 'none'", "script-src 'self'", "style-src 'unsafe-inline'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; '),
  });
}
function errorPage(res: Response, message: string): void {
  pageHeaders(res);
  res
    .status(400)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection error</title>` +
        `<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#222}</style></head>` +
        `<body><h1>Cannot connect</h1><p>${esc(message)}</p><p>Go back to your AI app and try again.</p></body></html>`,
    );
}

// ---------- demo account (replaces Google / GitHub login) ----------
/** The one shared demo user. Must be a real user id from Supabase Auth, Users. Works in production too (sandbox app). */
function demoUserId(): string {
  const id = opt('DEMO_USER_ID') || opt('DEV_USER_ID');
  return isUuid(id) ? id : '';
}
/** Returns the demo user id, or sends an error and returns null. */
function demoLogin(res: Response): string | null {
  const id = demoUserId();
  if (!id) {
    oauthError(res, 503, 'temporarily_unavailable', 'Demo account is not configured (set DEMO_USER_ID).');
    return null;
  }
  return id;
}

export const oauthRouter = Router();

// ---------- 2. metadata ----------
const protectedResourceMetadata: RequestHandler = (_req, res) => {
  res.json({ resource: resourceUrl(), authorization_servers: [baseUrl()], bearer_methods_supported: ['header'] });
};
// Both the root URL and the path-inserted URL for /mcp (RFC 9728), so every client finds it.
oauthRouter.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], protectedResourceMetadata);

oauthRouter.get('/.well-known/oauth-authorization-server', (_req, res) => {
  const b = baseUrl();
  res.json({
    issuer: b,
    authorization_endpoint: `${b}/authorize`,
    token_endpoint: `${b}/token`,
    registration_endpoint: `${b}/register`,
    response_types_supported: ['code'],
    grant_types_supported: GRANTS,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true, // RFC 9207: we send iss in the redirect
  });
});

// ---------- 3. dynamic client registration (RFC 7591, public clients only) ----------
oauthRouter.post(
  '/register',
  limited('register'),
  ah(async (req, res) => {
    const b = asObj(req.body);
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every(isValidRedirectUri)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be 1 to 10 URIs: https, or http on localhost/127.0.0.1, or a custom app scheme.');
    }
    if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') {
      return oauthError(res, 400, 'invalid_client_metadata', 'Only public clients are supported (token_endpoint_auth_method "none").');
    }
    const subset = (v: unknown, allowed: string[]): boolean => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string' && allowed.includes(x)));
    if (!subset(b.grant_types, GRANTS)) return oauthError(res, 400, 'invalid_client_metadata', 'grant_types must be authorization_code and/or refresh_token.');
    if (!subset(b.response_types, ['code'])) return oauthError(res, 400, 'invalid_client_metadata', 'response_types must be "code".');

    const redirect_uris = [...new Set(uris as string[])];
    // Strip control and bidi-override characters so the name cannot spoof the consent screen.
    const name =
      str(b.client_name)
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100) || 'MCP client';
    const client_id = randomUUID();
    const { error } = await db.from('oauth_clients').insert({ client_id, redirect_uris, client_name: name });
    if (error) throw new Error(error.message);
    noStore(res);
    res.status(201).json({
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris,
      grant_types: GRANTS,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }),
);

// ---------- 4. authorize ----------
oauthRouter.get(
  '/authorize',
  ah(async (req, res) => {
    const r = await validateAuthRequest(req.query);
    if (!r.ok) {
      if (r.fatal || !r.redirectUri) return errorPage(res, r.description);
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return void res.redirect(302, buildRedirect(r.redirectUri, { error: r.error, error_description: r.description, state: r.state }));
    }
    const q = new URLSearchParams({
      client_id: r.v.client.client_id,
      redirect_uri: r.v.redirect_uri,
      code_challenge: r.v.code_challenge,
      state: r.v.state,
    });
    const resource = str(req.query.resource);
    if (resource) q.set('resource', resource);
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.redirect(302, `/oauth/login?${q.toString()}`);
  }),
);

// Static login + consent page (its script is a separate file so the CSP can forbid inline scripts).
oauthRouter.get('/oauth/login', (_req, res) => {
  pageHeaders(res);
  res.sendFile(path.join(pub, 'oauth-login.html'));
});
oauthRouter.get('/oauth/login.js', (_req, res) => {
  pageHeaders(res);
  res.sendFile(path.join(pub, 'oauth-login.js'));
});

// The consent page asks the server for the client name and demo settings, so the name shown is never taken from the URL.
oauthRouter.get(
  '/oauth/client-info',
  ah(async (req, res) => {
    noStore(res);
    const client = await getClient(str(req.query.client_id));
    const uri = str(req.query.redirect_uri);
    if (!client || !client.redirect_uris.includes(uri)) return oauthError(res, 400, 'invalid_request', 'Unknown client or redirect_uri.');
    const u = new URL(uri);
    res.json({ demo_enabled: demoUserId() !== '', client_name: client.client_name, redirect_host: u.protocol === 'https:' || u.protocol === 'http:' ? u.host : `${u.protocol}//` });
  }),
);

/** Fields the consent page sends back. Everything is validated again here; the page is not trusted. */
const fromBody = (body: unknown): Record<string, unknown> => ({ ...asObj(body), response_type: 'code', code_challenge_method: 'S256' });

oauthRouter.post(
  '/oauth/approve',
  limited('approve'),
  ah(async (req, res) => {
    noStore(res);
    const v = await validateAuthRequest(fromBody(req.body));
    if (!v.ok) return oauthError(res, 400, v.error, v.description);
    const userId = demoLogin(res);
    if (!userId) return;

    const code = randomBytes(32).toString('base64url');
    const { error: insErr } = await db.from('oauth_codes').insert({
      code_hash: sha256hex(code),
      client_id: v.v.client.client_id,
      user_id: userId,
      redirect_uri: v.v.redirect_uri,
      code_challenge: v.v.code_challenge,
      expires_at: new Date(Date.now() + CODE_TTL_S * 1000).toISOString(),
      used: false,
    });
    if (insErr) throw new Error(insErr.message);
    res.json({ redirect_url: buildRedirect(v.v.redirect_uri, { code, state: v.v.state }) });
  }),
);

// Demo login for the built-in web pages (/login, /chat): returns a short-lived access token for the demo user.
oauthRouter.get('/demo/info', (_req, res) => {
  noStore(res);
  res.json({ demo_enabled: demoUserId() !== '' });
});

// Check if the current demo bearer token is valid and unrevoked.
oauthRouter.get(
  ['/demo/session', '/api/auth/session'],
  ah(async (req, res) => {
    noStore(res);
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+([A-Za-z0-9_.-]+)$/.exec(h.trim());
    if (!m) {
      return void res.status(401).json({ authenticated: false, error: 'missing_token' });
    }
    const token = m[1];
    let user: { id: string } | null = null;
    if (token.startsWith(ACCESS_PREFIX)) {
      user = await verifyAccessToken(token);
    } else {
      try {
        const { data, error } = await db.auth.getUser(token);
        if (!error && data?.user) user = { id: data.user.id };
      } catch {
        user = null;
      }
    }
    if (!user) {
      return void res.status(401).json({ authenticated: false, error: 'invalid_or_revoked' });
    }
    res.json({ authenticated: true, user_id: user.id });
  }),
);

oauthRouter.post(
  '/demo/session',
  limited('demo'),
  ah(async (req, res) => {
    noStore(res);
    const userId = demoLogin(res);
    if (!userId) return;
    // Internal client row for the web pages (tokens need a client). It is not used for redirects.
    const { error } = await db.from('oauth_clients').upsert({ client_id: WEB_CLIENT, redirect_uris: ['urn:ai-shop:web'], client_name: 'AI Shop web' }, { onConflict: 'client_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    const t = await issueTokens(userId, WEB_CLIENT);
    res.json({ access_token: t.access_token, expires_in: t.expires_in });
  }),
);

// Revoke session token on logout.
oauthRouter.post(
  ['/demo/logout', '/api/auth/logout'],
  ah(async (req, res) => {
    noStore(res);
    const h = req.headers.authorization ?? '';
    let token = '';
    const m = /^Bearer\s+([A-Za-z0-9_.-]+)$/.exec(h.trim());
    if (m) {
      token = m[1];
    } else if (typeof req.body?.token === 'string') {
      token = req.body.token.trim();
    }
    if (token) {
      const hsh = sha256hex(token);
      await db.from('oauth_tokens').update({ revoked: true }).eq('token_hash', hsh);
    }
    res.json({ ok: true });
  }),
);

oauthRouter.post(
  '/oauth/deny',
  limited('approve'),
  ah(async (req, res) => {
    noStore(res);
    const v = await validateAuthRequest(fromBody(req.body));
    if (!v.ok) return oauthError(res, 400, v.error, v.description);
    res.json({ redirect_url: buildRedirect(v.v.redirect_uri, { error: 'access_denied', error_description: 'The user denied the request.', state: v.v.state }) });
  }),
);

// ---------- 5. token ----------
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

oauthRouter.post(
  '/token',
  limited('token'),
  ah(async (req, res) => {
    const b = asObj(req.body);
    const client = await getClient(str(b.client_id));
    if (!client) return oauthError(res, 401, 'invalid_client', 'Unknown client_id.');
    if (!resourceOk(str(b.resource))) return oauthError(res, 400, 'invalid_target', 'resource must be the MCP server URL.');

    const grant = str(b.grant_type);

    if (grant === 'authorization_code') {
      const code = str(b.code);
      const redirectUri = str(b.redirect_uri);
      const verifier = str(b.code_verifier);
      if (!code || !redirectUri || !VERIFIER_RE.test(verifier)) {
        return oauthError(res, 400, 'invalid_request', 'code, redirect_uri and a valid code_verifier are required.');
      }
      // One atomic UPDATE: only one request can ever flip used=false to true, so a code works once.
      // The code is burned even if a check below fails (stops guessing and replay).
      const { data: row, error } = await db
        .from('oauth_codes')
        .update({ used: true })
        .eq('code_hash', sha256hex(code))
        .eq('used', false)
        .gt('expires_at', new Date().toISOString())
        .select('client_id, user_id, redirect_uri, code_challenge')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) return oauthError(res, 400, 'invalid_grant', 'Code is invalid, expired or already used.');
      if (row.client_id !== client.client_id || !safeEqual(row.redirect_uri as string, redirectUri)) {
        return oauthError(res, 400, 'invalid_grant', 'Code was not issued to this client or redirect_uri.');
      }
      const computed = createHash('sha256').update(verifier).digest('base64url');
      if (!safeEqual(computed, row.code_challenge as string)) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
      noStore(res);
      return void res.json(await issueTokens(row.user_id as string, client.client_id));
    }

    if (grant === 'refresh_token') {
      const refresh = str(b.refresh_token);
      if (!refresh) return oauthError(res, 400, 'invalid_request', 'refresh_token is required.');
      const h = sha256hex(refresh);
      // Rotation: atomically revoke the old pair. If two requests race, only one wins.
      const { data: old, error } = await db
        .from('oauth_tokens')
        .update({ revoked: true })
        .eq('refresh_hash', h)
        .eq('client_id', client.client_id)
        .eq('revoked', false)
        .gt('refresh_expires_at', new Date().toISOString())
        .select('user_id')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!old) {
        // An already-rotated refresh token being used again means it may have leaked: revoke the whole session.
        const { data: seen } = await db.from('oauth_tokens').select('user_id, client_id, revoked').eq('refresh_hash', h).maybeSingle();
        if (seen && seen.revoked && seen.client_id === client.client_id) {
          await db.from('oauth_tokens').update({ revoked: true }).eq('user_id', seen.user_id as string).eq('client_id', client.client_id);
        }
        return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid, expired or already used.');
      }
      noStore(res);
      return void res.json(await issueTokens(old.user_id as string, client.client_id));
    }

    oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }),
);

// ---------- housekeeping: delete expired rows once an hour ----------
setInterval(() => {
  const done = (): void => undefined;
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  void db.from('oauth_codes').delete().lt('expires_at', dayAgo).then(done, done);
  void db.from('oauth_tokens').delete().lt('refresh_expires_at', new Date().toISOString()).then(done, done);
}, 60 * 60 * 1000).unref();
