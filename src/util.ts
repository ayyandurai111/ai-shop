import { timingSafeEqual } from 'node:crypto';

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const toCents = (n: number | string): number => Math.round(Number(n) * 100);
export const fromCents = (c: number): string => (c / 100).toFixed(2);

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const isUuid = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
