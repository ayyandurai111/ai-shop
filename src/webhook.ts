import type { Request, Response } from 'express';
import { db } from './db.js';
import { verifyWebhook } from './paypal.js';

const nowIso = (): string => new Date().toISOString();

function captureFromLinks(r: any): string | null {
  const up = (r.links ?? []).find((l: any) => l.rel === 'up');
  return up?.href ? String(up.href).split('/').pop() ?? null : null;
}

async function findOrder(type: string, r: any): Promise<any | null> {
  const ppOrder = r.supplementary_data?.related_ids?.order_id;
  if (ppOrder) {
    const { data } = await db.from('orders').select('*').eq('paypal_order_id', ppOrder).maybeSingle();
    if (data) return data;
  }
  const captureId = type.startsWith('CUSTOMER.DISPUTE')
    ? r.disputed_transactions?.[0]?.seller_transaction_id
    : type === 'PAYMENT.CAPTURE.REFUNDED'
      ? captureFromLinks(r)
      : r.id;
  if (!captureId) return null;
  const { data } = await db.from('orders').select('*').eq('capture_id', captureId).maybeSingle();
  return data ?? null;
}

async function setStatus(orderId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  await db.from('orders').update({ status, updated_at: nowIso(), ...extra }).eq('id', orderId);
}

async function handleEvent(event: any): Promise<void> {
  const type: string = event.event_type ?? '';
  const r = event.resource ?? {};

  if (type === 'VAULT.PAYMENT-TOKEN.CREATED') {
    const userId = r.customer?.merchant_customer_id;
    if (userId && r.id) {
      await db.from('paypal_accounts').upsert({
        user_id: userId,
        payment_token_id: r.id,
        vault_customer_id: r.customer?.id ?? null,
        status: 'ACTIVE',
        updated_at: nowIso(),
      });
    }
    // The vault token id is never stored in the event log.
    await db.from('payment_events').insert({ order_id: null, event_type: type, payload: { id: event.id, create_time: event.create_time } });
    return;
  }

  const order = await findOrder(type, r);
  await db.from('payment_events').insert({ order_id: order?.id ?? null, event_type: type, payload: event });
  if (!order) return;

  switch (type) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      if (order.status === 'PENDING') await setStatus(order.id, 'COMPLETED', { capture_id: r.id });
      break;
    case 'PAYMENT.CAPTURE.REFUNDED': {
      const refunded = Number(r.amount?.value ?? 0);
      await setStatus(order.id, refunded >= Number(order.total) ? 'REFUNDED' : 'PARTIALLY_REFUNDED');
      break;
    }
    case 'CUSTOMER.DISPUTE.CREATED':
    case 'CUSTOMER.DISPUTE.UPDATED':
      if (['COMPLETED', 'PARTIALLY_REFUNDED', 'DISPUTED'].includes(order.status)) await setStatus(order.id, 'DISPUTED');
      break;
    case 'CUSTOMER.DISPUTE.RESOLVED': {
      const outcome: string = r.dispute_outcome?.outcome_code ?? '';
      await setStatus(order.id, outcome === 'RESOLVED_BUYER_FAVOUR' ? 'REFUNDED' : 'COMPLETED');
      break;
    }
  }
}

/** Mounted with express.raw() so the signature can be checked against the exact bytes. */
export async function paypalWebhook(req: Request, res: Response): Promise<void> {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }
  let verified = false;
  try {
    verified = await verifyWebhook(req.headers, raw);
  } catch (e) {
    console.error('webhook verify error:', e instanceof Error ? e.message : 'unknown');
  }
  if (!verified) {
    res.status(400).json({ error: 'Signature not verified' });
    return;
  }
  try {
    await handleEvent(event);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('webhook handler error:', e instanceof Error ? e.message : 'unknown');
    res.status(500).json({ error: 'handler error' }); // PayPal will retry
  }
}
