import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireAuth } from './auth.js';
import { need, opt } from './config.js';
import { buildMcpServer } from './mcp.js';
import { oauthCors, oauthRouter } from './oauth.js';
import { api } from './routes.js';
import { paypalWebhook } from './webhook.js';

// Fail fast on missing config.
['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'BASE_URL'].forEach(need);

const app = express();
app.set('trust proxy', 1);
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Webhook needs the raw body, so it is mounted BEFORE express.json().
app.post('/webhooks/paypal', express.raw({ type: '*/*', limit: '1mb' }), paypalWebhook);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' })); // /token is form-encoded per OAuth

// Minimal CORS for browser-based MCP clients (the bearer token is the protection).
app.use('/mcp', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate'); // browser clients read the OAuth discovery header
  if (req.method === 'OPTIONS') return void res.status(204).end();
  next();
});

// OAuth discovery, registration and token endpoints are called from browser-based MCP clients too.
app.use(['/.well-known', '/register', '/token'], oauthCors);

app.get('/health', (_req, res) => void res.json({ ok: true }));
app.get('/config.json', (_req, res) => void res.json({ supabaseUrl: opt('SUPABASE_URL'), supabaseAnonKey: opt('SUPABASE_ANON_KEY') }));

// 3 tiny static pages
app.get('/', (_req, res) => void res.redirect('/chat'));
app.get('/login', (_req, res) => void res.sendFile(path.join(pub, 'login.html')));
app.get('/chat', (_req, res) => void res.sendFile(path.join(pub, 'chat.html')));
app.get('/paypal/return', (_req, res) => void res.sendFile(path.join(pub, 'paypal-return.html')));
app.get('/common.js', (_req, res) => void res.sendFile(path.join(pub, 'common.js')));

app.use(oauthRouter);
app.use(api);

// MCP: stateless Streamable HTTP, new server + transport per request.
app.post('/mcp', requireAuth, async (req, res) => {
  const server = buildMcpServer(req.user!.id);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('mcp error:', e instanceof Error ? e.message : 'unknown');
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});
const notAllowed = (_req: express.Request, res: express.Response): void =>
  void res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

// Malformed bodies etc.: JSON error instead of an HTML stack trace.
app.use((err: { status?: number; statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 400 && status < 500) return void res.status(status).json({ error: 'invalid_request' });
  console.error('unhandled error');
  res.status(500).json({ error: 'server_error' });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`AI shop listening on :${port}`));
