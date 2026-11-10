import { db } from '../db.js';
import { UserError } from '../errors.js';
import { chargeSavedAccount } from '../paypal.js';
import { fromCents, toCents } from '../util.js';
import { getActivePaymentToken } from './paypalAccount.js';
import { getSettings, todaySpendCents } from './settings.js';

export interface QuoteLine {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export async function prepareQuote(userId: string, items: { product_id: string; quantity: number }[]) {
  const merged = new Map<string, number>();
  for (const it of items) merged.set(it.product_id, (merged.get(it.product_id) ?? 0) + it.quantity);
  for (const q of merged.values()) if (q < 1 || q > 10) throw new UserError('Quantity per product must be between 1 and 10.');

  const ids = [...merged.keys()];
  const { data, error } = await db.from('products').select('id,name,price,currency,stock').in('id', ids);
  if (error) throw new Error(error.message);
  const byId = new Map((data ?? []).map((p: any) => [p.id as string, p]));

  const lines: QuoteLine[] = [];
  const currencies = new Set<string>();
  let totalC = 0;
  for (const id of ids) {
    const p: any = byId.get(id);
    const qty = merged.get(id)!;
    if (!p) throw new UserError(`Unknown product: ${id}`);
    if ((p.stock ?? 0) < qty) throw new UserError(`Not enough stock for "${p.name}" (available: ${p.stock ?? 0}).`);
    const unitC = toCents(p.price);
    currencies.add(p.currency ?? 'USD');
    totalC += unitC * qty;
    lines.push({ product_id: id, name: p.name, quantity: qty, unit_price: unitC / 100, line_total: (unitC * qty) / 100 });
  }
  if (currencies.size > 1) throw new UserError('All items in one purchase must use the same currency.');
  const currency = [...currencies][0] ?? 'USD';
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

  const { data: quote, error: qErr } = await db
    .from('quotes')
    .insert({ user_id: userId, items: lines, total: fromCents(totalC), currency, expires_at: expiresAt })
    .select('id')
    .single();
  if (qErr) throw new Error(qErr.message);

  return {
    quote_id: quote.id as string,
    items: lines,
    total: totalC / 100,
    currency,
    expires_at: expiresAt,
    next_step: 'Show this total to the user. Only after they explicitly say yes, call confirm_purchase.',
  };
}

export async function confirmPurchase(
  userId: string,
  a: { quote_id: string; confirmed_total: number; user_said_yes: boolean },
) {
  if (a.user_said_yes !== true) throw new UserError('Refused: the user has not explicitly said yes to this total.');

  const { data: quote, error } = await db.from('quotes').select('*').eq('id', a.quote_id).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!quote) throw new UserError('Quote not found. Call prepare_purchase again.');
  if (quote.used) throw new UserError('This quote was already used. Call prepare_purchase again.');
  if (new Date(quote.expires_at).getTime() < Date.now()) throw new UserError('This quote has expired. Call prepare_purchase again.');

  const totalC = toCents(quote.total);
  if (toCents(a.confirmed_total) !== totalC) {
    throw new UserError(`Refused: confirmed_total does not match the quoted total of ${fromCents(totalC)} ${quote.currency}.`);
  }

  const paymentToken = await getActivePaymentToken(userId);
  if (!paymentToken) throw new UserError('No active PayPal account. Use link_paypal_account first.');

  const settings = await getSettings(userId);
  if (totalC > toCents(settings.per_order_limit)) {
    throw new UserError(`Refused: total exceeds your per-order limit of ${settings.per_order_limit}.`);
  }
  const spent = await todaySpendCents(userId);
  if (spent + totalC > toCents(settings.daily_limit)) {
    throw new UserError(`Refused: this would exceed your daily limit of ${settings.daily_limit} (already spent today: ${fromCents(spent)}).`);
  }

  // Re-check stock and current prices so the quote cannot be stale.
  const lines: QuoteLine[] = quote.items;
  const { data: prods, error: pErr } = await db.from('products').select('id,name,price,stock').in('id', lines.map((l) => l.product_id));
  if (pErr) throw new Error(pErr.message);
  const byId = new Map((prods ?? []).map((p: any) => [p.id as string, p]));
  let nowC = 0;
  for (const l of lines) {
    const p: any = byId.get(l.product_id);
    if (!p || (p.stock ?? 0) < l.quantity) throw new UserError(`"${l.name}" is no longer available in that quantity. Prepare a new quote.`);
    nowC += toCents(p.price) * l.quantity;
  }
  if (nowC !== totalC) throw new UserError('Prices changed since the quote. Prepare a new quote.');

  // Mark the quote used BEFORE charging. The conditional update blocks races.
  const { data: claimed, error: cErr } = await db
    .from('quotes')
    .update({ used: true })
    .eq('id', quote.id)
    .eq('used', false)
    .select('id');
  if (cErr) throw new Error(cErr.message);
  if (!claimed || claimed.length === 0) throw new UserError('This quote was already used.');

  const { data: order, error: oErr } = await db
    .from('orders')
    .insert({ user_id: userId, status: 'PENDING', total: fromCents(totalC), currency: quote.currency, items: lines })
    .select('id')
    .single();
  if (oErr) throw new Error(oErr.message);

  const fail = async (reason: string, extra: Record<string, unknown> = {}): Promise<never> => {
    await db.from('orders').update({ status: 'FAILED', updated_at: new Date().toISOString(), ...extra }).eq('id', order.id);
    await db.from('payment_events').insert({ order_id: order.id, event_type: 'LOCAL.CHARGE_FAILED', payload: { reason } });
    throw new UserError(`Payment failed: ${reason}. You were not charged. Order ${order.id} is marked FAILED.`);
  };

  let charge;
  try {
    charge = await chargeSavedAccount(paymentToken, fromCents(totalC), quote.currency, quote.id, {
      customId: order.id,
      description: lines.map((l) => `${l.quantity}x ${l.name}`).join(', '),
    });
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!charge.ok) {
    return fail(`PayPal returned status ${charge.status}`, { paypal_order_id: charge.paypalOrderId });
  }

  await db
    .from('orders')
    .update({ status: 'COMPLETED', paypal_order_id: charge.paypalOrderId, capture_id: charge.captureId, updated_at: new Date().toISOString() })
    .eq('id', order.id);
  await db.from('payment_events').insert({
    order_id: order.id,
    event_type: 'LOCAL.CHARGE_COMPLETED',
    payload: { paypal_order_id: charge.paypalOrderId, capture_id: charge.captureId },
  });
  for (const l of lines) {
    const { data: ok } = await db.rpc('decrement_stock', { p_id: l.product_id, qty: l.quantity });
    if (ok === false) {
      await db.from('payment_events').insert({ order_id: order.id, event_type: 'LOCAL.STOCK_WARNING', payload: { product_id: l.product_id } });
    }
  }

  return {
    receipt: {
      order_id: order.id as string,
      status: 'COMPLETED',
      items: lines,
      total: totalC / 100,
      currency: quote.currency as string,
      paypal_order_id: charge.paypalOrderId,
      capture_id: charge.captureId,
    },
    message: 'Payment completed (PayPal sandbox).',
  };
}
