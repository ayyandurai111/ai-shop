import { db } from '../db.js';
import { UserError } from '../errors.js';
import { opt } from '../config.js';
import { round2 } from '../util.js';

/**
 * Channel3 = a universal product database (100M+ products, 25k retailers).
 * We search it live, then cache every result in our own `products` table.
 * The cache is the price authority: quotes and charges always read products.price from our DB,
 * never a number that came from the AI.
 */
const API = 'https://api.trychannel3.com';
const DEMO_STOCK = 10; // Channel3 only says InStock / OutOfStock. This is the sandbox inventory per product.

export const channel3Enabled = (): boolean => !!opt('CHANNEL3_API_KEY');

export interface C3SearchArgs {
  query: string;
  min_price?: number;
  max_price?: number;
  limit?: number;
}

export function mapChannel3Product(p: any): Record<string, unknown> | null {
  if (!p?.id || !p?.title) return null;
  // Best offer = cheapest in-stock USD offer.
  const offers: any[] = (p.offers ?? []).filter(
    (o: any) => o?.availability === 'InStock' && o?.price?.currency === 'USD' && Number(o?.price?.price) > 0,
  );
  if (!offers.length) return null;
  offers.sort((a, b) => Number(a.price.price) - Number(b.price.price));
  const best = offers[0];
  const price = round2(Number(best.price.price));
  const compare = Number(best.price.compare_at_price);
  const list = Number.isFinite(compare) && compare > price ? round2(compare) : price;
  const images: string[] = (p.images ?? []).map((i: any) => i?.url).filter((u: any) => typeof u === 'string' && u.startsWith('https://'));
  const main = (p.images ?? []).find((i: any) => i?.is_main_image)?.url ?? images[0] ?? null;
  const rating = Number(p.ratings?.value);
  return {
    id: `c3-${p.id}`,
    source: 'channel3',
    source_id: null,
    name: String(p.title).slice(0, 200),
    description: typeof p.description === 'string' ? p.description.slice(0, 1000) : null,
    brand: p.brands?.[0]?.name ?? null,
    category: p.category?.title ?? null,
    tags: [`retailer:${best.domain}`, ...((p.key_features ?? []) as string[]).slice(0, 4)],
    list_price: list,
    discount_percentage: list > price ? round2(((list - price) / list) * 100) : 0,
    price,
    currency: 'USD',
    rating: Number.isFinite(rating) && rating > 0 && rating <= 5 ? round2(rating) : null,
    stock: DEMO_STOCK,
    thumbnail_url: typeof main === 'string' && main.startsWith('https://') ? main : null,
    image_urls: images.slice(0, 6),
  };
}

export async function fetchChannel3(a: C3SearchArgs): Promise<any[]> {
  const key = opt('CHANNEL3_API_KEY');
  if (!key) throw new UserError('Product search is not configured: CHANNEL3_API_KEY is missing on the server.');
  const filters: Record<string, unknown> = { availability: ['InStock'] };
  if (a.min_price !== undefined || a.max_price !== undefined) {
    filters.price = { min_price: a.min_price ?? null, max_price: a.max_price ?? null };
  }
  const res = await fetch(`${API}/v1/search`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: a.query, limit: Math.min(a.limit ?? 10, 20), filters, config: { currency: 'USD', country: 'US' } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) throw new UserError('The Channel3 key (CHANNEL3_API_KEY) was rejected.');
  if (res.status === 429) throw new UserError('Channel3 is busy (rate limit). Try again in a moment.');
  if (!res.ok) {
    console.error('Channel3 error', res.status, (await res.text().catch(() => '')).slice(0, 300));
    throw new Error(`Channel3 request failed (HTTP ${res.status})`);
  }
  const j: any = await res.json();
  return Array.isArray(j.products) ? j.products : [];
}

/** Live search, then cache into products. Returns the cached rows (DB shape). */
export async function searchAndCache(a: C3SearchArgs): Promise<any[]> {
  const raw = await fetchChannel3(a);
  const rows = raw.map(mapChannel3Product).filter((r): r is Record<string, unknown> => r !== null);
  if (rows.length) {
    const { error } = await db.from('products').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(error.message);
  }
  return rows;
}

/** For the admin route and the seed script. */
export async function importChannel3(queries: string[], perQuery = 10) {
  let saved = 0;
  for (const q of queries) saved += (await searchAndCache({ query: q, limit: perQuery })).length;
  return { queries: queries.length, saved };
}
