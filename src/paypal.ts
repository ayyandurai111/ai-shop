import { randomUUID } from 'node:crypto';
import { baseUrl, need } from './config.js';
import { PayPalError } from './errors.js';

if ((process.env.PAYPAL_ENV ?? 'sandbox') !== 'sandbox') {
  throw new Error('This demo only runs against the PayPal sandbox. Set PAYPAL_ENV=sandbox.');
}
const BASE = 'https://api-m.sandbox.paypal.com';

let cached: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const basic = Buffer.from(`${need('PAYPAL_CLIENT_ID')}:${need('PAYPAL_CLIENT_SECRET')}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new PayPalError(`PayPal auth failed (HTTP ${res.status})`);
  cached = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 300) * 1000 };
  return cached.token;
}

interface PayPalOpts {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  requestId?: string;
}

export async function paypalFetch<T = any>(path: string, opts: PayPalOpts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await getAccessToken()}`,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST') headers['PayPal-Request-Id'] = opts.requestId ?? randomUUID();

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const debugId = json.debug_id ?? res.headers.get('paypal-debug-id') ?? 'n/a';
    const msg = json.message ?? json.error_description ?? json.name ?? `HTTP ${res.status}`;
    const issue = json.details?.[0]?.issue ? ` [${json.details[0].issue}]` : '';
    throw new PayPalError(`PayPal error: ${msg}${issue} (debug_id: ${debugId})`);
  }
  return json as T;
}

// ---- Vault: one-time buyer approval -----------------------------------
export async function createSetupToken(userId: string): Promise<{ setupTokenId: string; approveUrl: string }> {
  const r = await paypalFetch('/v3/vault/setup-tokens', {
    method: 'POST',
    body: {
      customer: { merchant_customer_id: userId },
      payment_source: {
        paypal: {
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          experience_context: {
            brand_name: 'AI Shop Demo',
            locale: 'en-US',
            shipping_preference: 'NO_SHIPPING',
            return_url: `${baseUrl()}/paypal/return`,
            cancel_url: `${baseUrl()}/paypal/return?cancelled=1`,
          },
        },
      },
    },
  });
  const link = (r.links ?? []).find((l: any) => l.rel === 'approve' || l.rel === 'payer-action');
  if (!r.id || !link?.href) throw new PayPalError('PayPal did not return an approval link');
  return { setupTokenId: r.id, approveUrl: link.href };
}

export async function createPaymentToken(setupTokenId: string): Promise<{ paymentTokenId: string; customerId: string | null }> {
  const r = await paypalFetch('/v3/vault/payment-tokens', {
    method: 'POST',
    body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
  });
  if (!r.id) throw new PayPalError('PayPal did not return a payment token');
  return { paymentTokenId: r.id, customerId: r.customer?.id ?? null };
}

export async function deletePaymentToken(id: string): Promise<void> {
  await paypalFetch(`/v3/vault/payment-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---- Charge from the backend, no buyer UI ------------------------------
export interface ChargeResult {
  paypalOrderId: string;
  status: string;
  captureId: string | null;
  ok: boolean;
}

export async function chargeSavedAccount(
  paymentTokenId: string,
  total: string,
  currency: string,
  requestId: string,
  meta: { customId: string; description: string },
): Promise<ChargeResult> {
  const r = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    requestId,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: meta.customId,
          description: meta.description.slice(0, 127),
          amount: { currency_code: currency, value: total },
        },
      ],
      payment_source: { paypal: { vault_id: paymentTokenId } },
    },
  });
  const captureId: string | null = r.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null;
  // Success ONLY when COMPLETED and a capture id exists (PAYER_ACTION_REQUIRED etc. = failure).
  return { paypalOrderId: r.id, status: r.status, captureId, ok: r.status === 'COMPLETED' && !!captureId };
}

export async function refundCapture(captureId: string, amount?: string, currency?: string, note?: string): Promise<any> {
  const body: Record<string, unknown> = {};
  if (amount && currency) body.amount = { value: amount, currency_code: currency };
  if (note) body.note_to_payer = note.slice(0, 255);
  return paypalFetch(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, { method: 'POST', body });
}

export const getOrder = (id: string): Promise<any> => paypalFetch(`/v2/checkout/orders/${encodeURIComponent(id)}`);
export const listDisputes = (pageSize = 20): Promise<any> => paypalFetch(`/v1/customer/disputes?page_size=${pageSize}`);
export const getDispute = (id: string): Promise<any> => paypalFetch(`/v1/customer/disputes/${encodeURIComponent(id)}`);

// ---- Webhook signature check -------------------------------------------
export async function verifyWebhook(headers: Record<string, any>, rawBody: string): Promise<boolean> {
  const h = (k: string): string => String(headers[k] ?? '');
  // Build the body by string concat so the event is sent byte-for-byte as received.
  const body =
    `{"auth_algo":${JSON.stringify(h('paypal-auth-algo'))},` +
    `"cert_url":${JSON.stringify(h('paypal-cert-url'))},` +
    `"transmission_id":${JSON.stringify(h('paypal-transmission-id'))},` +
    `"transmission_sig":${JSON.stringify(h('paypal-transmission-sig'))},` +
    `"transmission_time":${JSON.stringify(h('paypal-transmission-time'))},` +
    `"webhook_id":${JSON.stringify(need('PAYPAL_WEBHOOK_ID'))},` +
    `"webhook_event":${rawBody}}`;
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  const json: any = await res.json().catch(() => ({}));
  return res.ok && json.verification_status === 'SUCCESS';
}
