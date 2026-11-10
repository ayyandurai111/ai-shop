import { db } from '../db.js';
import { num } from '../config.js';
import { UserError } from '../errors.js';
import { toCents } from '../util.js';

export const SPEND_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'DISPUTED'];

export async function getSettings(userId: string): Promise<{ per_order_limit: number; daily_limit: number }> {
  const { data } = await db.from('user_settings').select('per_order_limit,daily_limit').eq('user_id', userId).maybeSingle();
  return { per_order_limit: Number(data?.per_order_limit ?? 50), daily_limit: Number(data?.daily_limit ?? 100) };
}

export async function setLimits(userId: string, perOrder: number, daily: number) {
  const cap = num('MAX_LIMIT', 200);
  if (perOrder <= 0 || daily <= 0) throw new UserError('Limits must be greater than 0.');
  if (perOrder > cap || daily > cap) throw new UserError(`Limits cannot be raised above the hard cap of ${cap}.`);
  if (perOrder > daily) throw new UserError('per_order_limit cannot be higher than daily_limit.');
  const { error } = await db.from('user_settings').upsert({ user_id: userId, per_order_limit: perOrder, daily_limit: daily });
  if (error) throw new Error(error.message);
  return { per_order_limit: perOrder, daily_limit: daily, max_allowed: cap };
}

/** Today's (UTC) spend in cents from orders that still count against the daily limit. */
export async function todaySpendCents(userId: string): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await db
    .from('orders')
    .select('total')
    .eq('user_id', userId)
    .in('status', SPEND_STATUSES)
    .gte('created_at', start.toISOString());
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((s: number, o: any) => s + toCents(o.total), 0);
}
