export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}
export const opt = (name: string, fallback = ''): string => process.env[name] ?? fallback;
export const isProd = (): boolean => process.env.NODE_ENV === 'production';
export function num(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export const baseUrl = (): string => need('BASE_URL').replace(/\/+$/, '');
