const hits = new Map<string, { n: number; reset: number }>();

/** Fixed window: `limit` calls per minute per key. */
export function allow(key: string, limit = 30): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now >= h.reset) {
    hits.set(key, { n: 1, reset: now + 60_000 });
    return true;
  }
  h.n += 1;
  return h.n <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now >= v.reset) hits.delete(k);
}, 60_000).unref();
