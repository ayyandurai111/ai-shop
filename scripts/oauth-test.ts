// OAuth smoke test: runs the whole MCP flow (discovery, register, PKCE, approve, token, refresh) with NO manual token.
// Needs the server running with DEMO_USER_ID (or DEV_USER_ID) set. For the cleanup it also needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.
// The browser step (press Allow) is done by calling /oauth/approve directly.
// Never charges money. Deletes its test client at the end. Never prints tokens, codes or verifiers.
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`Missing env var ${n}`);
  return v;
};
const REDIRECT = 'http://localhost:8976/callback';
let failed = 0;
const check = (name: string, cond: boolean): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
};
const b64 = (b: Buffer): string => b.toString('base64url');
const form = (o: Record<string, string>): URLSearchParams => new URLSearchParams(o);

async function token(body: Record<string, string>): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function mcp(accessToken: string, method: string, id: number): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1' } } : {} }),
  });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  let json: any = {};
  try {
    json = JSON.parse(line ? line.slice(5).trim() : text);
  } catch {
    /* non-JSON body (401 etc.) */
  }
  return { status: r.status, json };
}

/** Runs /authorize then /oauth/approve (what the browser page does) and returns the code. */
async function getCode(clientId: string, challenge: string, state: string): Promise<string> {
  const q = form({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state, resource: `${BASE}/mcp` });
  const a = await fetch(`${BASE}/authorize?${q}`, { redirect: 'manual' });
  const loc = a.headers.get('location') ?? '';
  check('/authorize redirects to /oauth/login', a.status === 302 && loc.startsWith('/oauth/login?'));
  const page = await fetch(`${BASE}/oauth/login`);
  check('/oauth/login page is served and cannot be framed', page.status === 200 && page.headers.get('x-frame-options') === 'DENY');

  const body = { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, state, resource: `${BASE}/mcp` };
  const ap = await fetch(`${BASE}/oauth/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await ap.json().catch(() => ({}));
  const url = new URL(j.redirect_url ?? 'http://invalid.invalid/');
  check('approve redirects to the exact redirect_uri with code, state and iss', ap.status === 200 && url.origin + url.pathname === REDIRECT && url.searchParams.get('state') === state && url.searchParams.get('iss') === BASE);
  return url.searchParams.get('code') ?? '';
}

const admin = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
let clientId = '';
try {
  // 1. 401 + discovery header
  const r401 = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const wa = r401.headers.get('www-authenticate') ?? '';
  check('/mcp without a token: 401 + WWW-Authenticate resource_metadata', r401.status === 401 && wa === `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);

  // 2. metadata
  const prm: any = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  check('protected resource metadata', prm.resource === `${BASE}/mcp` && prm.authorization_servers?.[0] === BASE);
  const prm2: any = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  check('protected resource metadata (path-inserted URL)', prm2.resource === `${BASE}/mcp`);
  const as: any = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check(
    'authorization server metadata',
    as.issuer === BASE && as.authorization_endpoint === `${BASE}/authorize` && as.token_endpoint === `${BASE}/token` && as.registration_endpoint === `${BASE}/register` &&
      as.code_challenge_methods_supported?.join() === 'S256' && as.token_endpoint_auth_methods_supported?.join() === 'none' && as.grant_types_supported?.includes('refresh_token'),
  );
  const pre = await fetch(`${BASE}/token`, { method: 'OPTIONS' });
  check('CORS preflight on /token', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*');

  // 3. dynamic client registration
  const bad = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  check('register rejects http on a non-local host', bad.status === 400);
  const js = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }) });
  check('register rejects javascript: redirect', js.status === 400);
  const reg = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'OAuth smoke test', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  const regJson: any = await reg.json();
  clientId = regJson.client_id ?? '';
  check('register returns 201 and a client_id', reg.status === 201 && !!clientId);

  // 4. /authorize checks
  const goodChal = b64(createHash('sha256').update('x').digest());
  const probe = async (over: Record<string, string>): Promise<number> =>
    (await fetch(`${BASE}/authorize?${form({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: goodChal, code_challenge_method: 'S256', state: 's', ...over })}`, { redirect: 'manual' })).status;
  check('authorize: wrong redirect_uri shows an error page (no redirect)', (await probe({ redirect_uri: `${REDIRECT}/x` })) === 400);
  const plain = await fetch(`${BASE}/authorize?${form({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: goodChal, code_challenge_method: 'plain', state: 's' })}`, { redirect: 'manual' });
  check('authorize: PKCE method "plain" is refused with an error redirect', plain.status === 302 && (plain.headers.get('location') ?? '').includes('error=invalid_request'));

  // 5. full flow
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash('sha256').update(verifier).digest());
  const state = b64(randomBytes(16));

  // wrong verifier: refused, and the code is burned
  const codeA = await getCode(clientId, challenge, state);
  const wrong = await token({ grant_type: 'authorization_code', client_id: clientId, code: codeA, redirect_uri: REDIRECT, code_verifier: b64(randomBytes(32)) });
  check('token: wrong code_verifier is refused (invalid_grant)', wrong.status === 400 && wrong.json.error === 'invalid_grant');
  const burned = await token({ grant_type: 'authorization_code', client_id: clientId, code: codeA, redirect_uri: REDIRECT, code_verifier: verifier });
  check('token: a failed attempt burns the code', burned.status === 400 && burned.json.error === 'invalid_grant');

  // good exchange
  const codeB = await getCode(clientId, challenge, state);
  const badRedirect = await token({ grant_type: 'authorization_code', client_id: clientId, code: codeB, redirect_uri: `${REDIRECT}2`, code_verifier: verifier });
  check('token: wrong redirect_uri is refused', badRedirect.status === 400);
  const codeC = await getCode(clientId, challenge, state);
  const t1 = await token({ grant_type: 'authorization_code', client_id: clientId, code: codeC, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp` });
  check('token: code + verifier gives access + refresh token (Bearer, 3600s)', t1.status === 200 && !!t1.json.access_token && !!t1.json.refresh_token && t1.json.token_type === 'Bearer' && t1.json.expires_in === 3600);
  const reuse = await token({ grant_type: 'authorization_code', client_id: clientId, code: codeC, redirect_uri: REDIRECT, code_verifier: verifier });
  check('token: a code cannot be used twice', reuse.status === 400 && reuse.json.error === 'invalid_grant');

  // 6. the token works on /mcp
  const init = await mcp(t1.json.access_token, 'initialize', 1);
  check('/mcp initialize works with the OAuth access token', init.status === 200 && !!init.json.result?.serverInfo);
  const tools = await mcp(t1.json.access_token, 'tools/list', 2);
  check('/mcp tools/list works with the OAuth access token', tools.status === 200 && (tools.json.result?.tools?.length ?? 0) > 0);
  const garbage = await mcp('mcp_at_notarealtoken', 'tools/list', 3);
  check('/mcp refuses an unknown OAuth token', garbage.status === 401);

  // refresh rotation
  const t2 = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: t1.json.refresh_token });
  check('refresh: returns a new access + refresh token', t2.status === 200 && !!t2.json.access_token && t2.json.refresh_token !== t1.json.refresh_token);
  check('refresh: the old access token stops working', (await mcp(t1.json.access_token, 'tools/list', 4)).status === 401);
  check('refresh: the new access token works', (await mcp(t2.json.access_token, 'tools/list', 5)).status === 200);
  const replay = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: t1.json.refresh_token });
  check('refresh: the old refresh token is invalid', replay.status === 400 && replay.json.error === 'invalid_grant');
  check('refresh: reuse of an old refresh token revokes the whole session', (await mcp(t2.json.access_token, 'tools/list', 6)).status === 401);

  // demo login used by /login and /chat
  const ds = await fetch(`${BASE}/demo/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const dj: any = await ds.json().catch(() => ({}));
  check('/demo/session gives a token that works on the REST API', ds.status === 200 && (await fetch(`${BASE}/api/paypal/status`, { headers: { Authorization: `Bearer ${dj.access_token}` } })).status === 200);
} finally {
  if (clientId) await admin.from('oauth_clients').delete().eq('client_id', clientId); // cascades to codes and tokens
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
