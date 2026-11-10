import { db } from '../db.js';
import { UserError } from '../errors.js';
import { channel3Enabled, searchAndCache } from './channel3.js';

const pub = (p: any) => ({
  id: p.id,
  name: p.name,
  brand: p.brand,
  category: p.category,
  price: Number(p.price),
  list_price: p.list_price === null ? null : Number(p.list_price),
  discount_percentage: Number(p.discount_percentage ?? 0),
  rating: p.rating === null ? null : Number(p.rating),
  stock: p.stock,
  thumbnail_url: p.thumbnail_url,
});

export interface SearchArgs {
  query?: string;
  category?: string;
  min_price?: number;
  max_price?: number;
  in_stock_only?: boolean;
  limit?: number;
}

export async function searchProducts(a: SearchArgs) {
  // Live catalog: Channel3. Results are cached in `products`, so prepare/confirm purchase read our own prices.
  const q = [a.query?.trim(), a.category?.trim()].filter(Boolean).join(' ');
  if (channel3Enabled() && q) {
    try {
      let rows = await searchAndCache({ query: q, min_price: a.min_price, max_price: a.max_price, limit: a.limit });
      if (a.in_stock_only) rows = rows.filter((r: any) => r.stock > 0);
      return rows.slice(0, Math.min(a.limit ?? 10, 20)).map(pub);
    } catch (e) {
      if (e instanceof UserError) throw e;
      console.error('Channel3 search failed, using cached products:', e instanceof Error ? e.message : 'unknown');
    }
  }
  const { data, error } = await db.rpc('search_products', {
    q: a.query?.trim() || null,
    cat: a.category ?? null,
    minp: a.min_price ?? null,
    maxp: a.max_price ?? null,
    instock: a.in_stock_only ?? false,
    lim: Math.min(a.limit ?? 10, 20),
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as any[]).map(pub);
}

export async function getProduct(id: string) {
  const { data, error } = await db.from('products').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new UserError(`Product not found: ${id}`);
  return { ...pub(data), description: data.description, tags: data.tags, currency: data.currency, image_urls: data.image_urls };
}

export async function listCategories() {
  const { data, error } = await db.from('products').select('category').limit(5000);
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const r of (data ?? []) as any[]) if (r.category) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return [...counts.entries()].sort().map(([category, products]) => ({ category, products }));
}
