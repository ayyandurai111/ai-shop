import { z, type ZodRawShape } from 'zod';
import { UserError } from './errors.js';
import { allow } from './ratelimit.js';
import { logTool } from './services/log.js';
import { getProduct, listCategories, searchProducts } from './services/products.js';
import { getLinkStatus, startLinking, unlinkAccount } from './services/paypalAccount.js';
import { setLimits } from './services/settings.js';
import { confirmPurchase, prepareQuote } from './services/purchase.js';
import { getOrder, listOrders, refundOrder } from './services/orders.js';
import { getDispute, listDisputes } from './services/disputes.js';

export interface ToolDef {
  name: string;
  description: string;
  shape: ZodRawShape;
  handler: (userId: string, args: any) => Promise<unknown>;
}
export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

// NOTE: no tool has a price or total field to SET. Prices always come from products.price.
export const TOOLS: ToolDef[] = [
  {
    name: 'search_products',
    description:
      'Search the live product catalog (Channel3, real retailers). Describe the product in plain words, e.g. "wireless headphones". Returns id, name, brand, category, price (final selling price), list_price, discount_percentage, rating, stock and thumbnail_url.',
    shape: {
      query: z.string().max(100).optional().describe('Free text, e.g. "red lipstick" or "laptop"'),
      category: z.string().max(60).optional().describe('Exact category slug from list_categories'),
      min_price: z.number().min(0).optional(),
      max_price: z.number().min(0).optional(),
      in_stock_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(20).optional().describe('Max 20, default 10'),
    },
    handler: (_u, a) => searchProducts(a),
  },
  {
    name: 'get_product',
    description: 'Get full details of one product by its id (for example "c3-2yh8WH5"; ids come from search_products).',
    shape: { product_id: z.string().min(1).max(50) },
    handler: (_u, a) => getProduct(a.product_id),
  },
  {
    name: 'list_categories',
    description: 'List the product categories in the store with product counts.',
    shape: {},
    handler: () => listCategories(),
  },
  {
    name: 'link_paypal_account',
    description:
      'Start the one-time PayPal (sandbox) account linking. Returns an approve_url the user must open once in a browser. After that, purchases are charged from the backend with no card form.',
    shape: {},
    handler: (u) => startLinking(u),
  },
  {
    name: 'get_paypal_link_status',
    description: 'Check whether the user has a PayPal account linked. Status is NONE, PENDING, ACTIVE or REMOVED.',
    shape: {},
    handler: (u) => getLinkStatus(u),
  },
  {
    name: 'unlink_paypal_account',
    description: 'Remove the saved PayPal account. Purchases are not possible until it is linked again.',
    shape: {},
    handler: (u) => unlinkAccount(u),
  },
  {
    name: 'set_spending_limits',
    description:
      'Set the per-order and daily spending limits. They can be lowered freely and raised only up to the server hard cap.',
    shape: { per_order_limit: z.number().positive(), daily_limit: z.number().positive() },
    handler: (u, a) => setLimits(u, a.per_order_limit, a.daily_limit),
  },
  {
    name: 'prepare_purchase',
    description:
      'Check items and stock and create a price quote valid for 10 minutes. This NEVER charges money. Show the item list and the total to the user and ask for a clear yes before anything else.',
    shape: {
      items: z
        .array(z.object({ product_id: z.string().min(1).max(50), quantity: z.number().int().min(1).max(10) }))
        .min(1)
        .max(10),
    },
    handler: (u, a) => prepareQuote(u, a.items),
  },
  {
    name: 'confirm_purchase',
    description:
      'Charge the user\'s saved PayPal account for a quote. NEVER call this unless the human has explicitly said yes to the EXACT total shown by prepare_purchase. Pass that total as confirmed_total and set user_said_yes to true only if they really said yes. If you are not sure, ask the user instead of calling this tool.',
    shape: {
      quote_id: z.string().uuid(),
      confirmed_total: z.number().describe('The exact total the user agreed to'),
      user_said_yes: z.boolean().describe('true only if the user explicitly agreed to this total'),
    },
    handler: (u, a) => confirmPurchase(u, a),
  },
  {
    name: 'get_order',
    description: 'Get one of the user\'s own orders by order id.',
    shape: { order_id: z.string().uuid() },
    handler: (u, a) => getOrder(u, a.order_id),
  },
  {
    name: 'list_my_orders',
    description: 'List the user\'s recent orders, newest first.',
    shape: { limit: z.number().int().min(1).max(20).optional() },
    handler: (u, a) => listOrders(u, a.limit ?? 10),
  },
  {
    name: 'refund_order',
    description:
      'Refund the user\'s own captured order, fully or partly. Never more than the captured amount. Ask the user before refunding.',
    shape: {
      order_id: z.string().uuid(),
      amount: z.number().positive().optional().describe('Omit for a full refund of the remaining amount'),
      reason: z.string().max(200).optional(),
    },
    handler: (u, a) => refundOrder(u, a.order_id, a.amount, a.reason),
  },
  {
    name: 'list_disputes',
    description: 'Read-only: list PayPal disputes on the user\'s own orders.',
    shape: { limit: z.number().int().min(1).max(10).optional() },
    handler: (u, a) => listDisputes(u, a.limit ?? 10),
  },
  {
    name: 'get_dispute',
    description: 'Read-only: details of one dispute on the user\'s own orders.',
    shape: { dispute_id: z.string().min(1).max(40) },
    handler: (u, a) => getDispute(u, a.dispute_id),
  },
];

/** Single entry point for MCP and chat: rate limit, validate, run, log. */
export async function runTool(userId: string, name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  if (!allow(`tool:${userId}`, 30)) {
    await logTool(userId, name, args, false);
    return { ok: false, error: 'Rate limit: at most 30 tool calls per minute. Wait a moment and try again.' };
  }
  let ok = false;
  try {
    const parsed = z.object(tool.shape).safeParse(args ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      throw new UserError(`Invalid input: ${msg}`);
    }
    const data = await tool.handler(userId, parsed.data);
    ok = true;
    return { ok: true, data };
  } catch (e) {
    if (e instanceof UserError) return { ok: false, error: e.message };
    console.error(`tool ${name} failed:`, e instanceof Error ? e.message : 'unknown error');
    return { ok: false, error: 'Internal error. Please try again.' };
  } finally {
    await logTool(userId, name, args, ok);
  }
}
