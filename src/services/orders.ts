import { db } from '../db.js';
import { UserError } from '../errors.js';
import { refundCapture } from '../paypal.js';
import { fromCents, isUuid, toCents } from '../util.js';

const COLS = 'id,paypal_order_id,capture_id,status,total,currency,items,created_at';

async function getOwnOrder(userId: string, orderId: string): Promise<any> {
  if (!isUuid(orderId)) throw new UserError('Order not found.');
  const { data, error } = await db.from('orders').select(COLS).eq('id', orderId).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new UserError('Order not found.'); // same message for other users' orders
  return data;
}

export const getOrder = (userId: string, orderId: string) => getOwnOrder(userId, orderId);

export async function listOrders(userId: string, limit = 10) {
  const { data, error } = await db
    .from('orders')
    .select(COLS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 20));
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function refundedCents(orderId: string): Promise<number> {
  const { data } = await db.from('payment_events').select('payload').eq('order_id', orderId).eq('event_type', 'LOCAL.REFUND');
  return (data ?? []).reduce((s: number, e: any) => s + toCents(e.payload?.amount ?? 0), 0);
}

export async function refundOrder(userId: string, orderId: string, amount?: number, reason?: string) {
  const order = await getOwnOrder(userId, orderId);
  if (!order.capture_id || !['COMPLETED', 'PARTIALLY_REFUNDED', 'DISPUTED'].includes(order.status)) {
    throw new UserError('This order has no captured payment that can be refunded.');
  }
  const remainingC = toCents(order.total) - (await refundedCents(order.id));
  if (remainingC <= 0) throw new UserError('This order is already fully refunded.');
  const amountC = amount === undefined ? remainingC : toCents(amount);
  if (amountC <= 0 || amountC > remainingC) {
    throw new UserError(`Refund amount must be between 0.01 and ${fromCents(remainingC)} ${order.currency}.`);
  }
  const r = await refundCapture(order.capture_id, fromCents(amountC), order.currency, reason);
  await db.from('payment_events').insert({
    order_id: order.id,
    event_type: 'LOCAL.REFUND',
    payload: { amount: Number(fromCents(amountC)), refund_id: r.id, status: r.status, reason: reason ?? null },
  });
  const status = amountC === remainingC ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await db.from('orders').update({ status, updated_at: new Date().toISOString() }).eq('id', order.id);
  return { order_id: order.id, refunded: Number(fromCents(amountC)), currency: order.currency, order_status: status, refund_status: r.status };
}
