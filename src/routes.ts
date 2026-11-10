import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { requireAuth } from './auth.js';
import { ChatBody, runChat } from './chat.js';
import { opt, num } from './config.js';
import { UserError } from './errors.js';
import { allow } from './ratelimit.js';
import { safeEqual } from './util.js';
import { getProduct, listCategories, searchProducts } from './services/products.js';
import { completeLinking, getLinkStatus, startLinking } from './services/paypalAccount.js';
import { listOrders } from './services/orders.js';
import { importChannel3 } from './services/channel3.js';
import { getSettings, setLimits, todaySpendCents } from './services/settings.js';

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((e: unknown) => {
      if (e instanceof UserError) return void res.status(400).json({ error: e.message });
      console.error('route error:', e instanceof Error ? e.message : 'unknown');
      res.status(500).json({ error: 'Internal error' });
    });
  };

const numQ = (v: unknown): number | undefined => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

export const api = Router();

// Public catalog
api.get('/api/products', wrap(async (req, res) => {
  res.json(await searchProducts({
    query: req.query.query ? String(req.query.query).slice(0, 100) : undefined,
    category: req.query.category ? String(req.query.category) : undefined,
    min_price: numQ(req.query.min_price),
    max_price: numQ(req.query.max_price),
    in_stock_only: req.query.in_stock_only === 'true',
    limit: numQ(req.query.limit),
  }));
}));
api.get('/api/products/:id', wrap(async (req, res) => res.json(await getProduct(String(req.params.id)))));
api.get('/api/categories', wrap(async (_req, res) => res.json(await listCategories())));

// Logged-in user
api.post('/api/paypal/link', requireAuth, wrap(async (req, res) => res.json(await startLinking(req.user!.id))));
api.post('/api/paypal/complete', requireAuth, wrap(async (req, res) => res.json(await completeLinking(req.user!.id))));
api.get('/api/paypal/status', requireAuth, wrap(async (req, res) => res.json(await getLinkStatus(req.user!.id))));
api.get('/api/orders', requireAuth, wrap(async (req, res) => res.json(await listOrders(req.user!.id, numQ(req.query.limit) ?? 10))));
api.get('/api/settings', requireAuth, wrap(async (req, res) => {
  const [s, spent] = await Promise.all([getSettings(req.user!.id), todaySpendCents(req.user!.id)]);
  res.json({ per_order_limit: s.per_order_limit, daily_limit: s.daily_limit, today_spend: spent / 100, max_allowed: num('MAX_LIMIT', 200) });
}));
api.post('/api/settings', requireAuth, wrap(async (req, res) => {
  const perOrder = numQ(req.body?.per_order_limit);
  const daily = numQ(req.body?.daily_limit);
  if (perOrder === undefined || daily === undefined) throw new UserError('Send per_order_limit and daily_limit as positive numbers.');
  res.json(await setLimits(req.user!.id, perOrder, daily));
}));

api.post('/api/chat', requireAuth, wrap(async (req, res) => {
  if (!allow(`chat:${req.user!.id}`, 20)) throw new UserError('Too many chat messages. Wait a minute.');
  const body = ChatBody.safeParse(req.body);
  if (!body.success) throw new UserError('Invalid chat body.');
  try {
    res.json(await runChat(req.user!.id, body.data.messages));
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('The last message')) throw new UserError(e.message);
    throw e;
  }
}));

// Admin: protected by ADMIN_TOKEN, not by a user JWT. Not an MCP tool.
api.post('/admin/import-channel3', wrap(async (req, res) => {
  const token = opt('ADMIN_TOKEN');
  const given = String(req.headers['x-admin-token'] ?? '');
  if (!token || !safeEqual(given, token)) return void res.status(401).json({ error: 'Unauthorized' });
  const raw = req.body?.queries;
  const queries: string[] = (Array.isArray(raw) ? raw : []).map((x: unknown) => String(x).slice(0, 100)).filter(Boolean).slice(0, 10);
  if (!queries.length) throw new UserError('Send {"queries": ["laptop", "running shoes"]}.');
  res.json(await importChannel3(queries, numQ(req.body?.limit) ?? 10));
}));
