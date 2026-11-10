// Safe smoke test: never charges money. Needs the server running and MCP_DEV_TOKEN + DEV_USER_ID set.
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.MCP_DEV_TOKEN ?? '';
let failed = 0;
const check = (name: string, cond: boolean): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
};

async function rpc(method: string, params: unknown, id: number): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5).trim() : text);
}
const call = async (name: string, args: unknown, id: number): Promise<any> => {
  const r = await rpc('tools/call', { name, arguments: args }, id);
  try {
    return JSON.parse(r.result.content[0].text);
  } catch {
    return { ok: false, error: JSON.stringify(r.error ?? r) };
  }
};

const noAuth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('/mcp without a token returns 401', noAuth.status === 401);
check('GET /mcp returns 405', (await fetch(`${BASE}/mcp`)).status === 405);

const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }, 1);
check('initialize works', !!init.result?.serverInfo);

const list = await rpc('tools/list', {}, 2);
const names: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
check('tools/list has 14 tools incl. confirm_purchase', names.length === 14 && names.includes('confirm_purchase'));
check('no tool lets the AI set a price', !(list.result?.tools ?? []).some((t: any) => JSON.stringify(t.inputSchema).match(/"(price|total)"/)));

const search = await call('search_products', { query: 'phone', limit: 3 }, 3);
check('search_products returns results', search.ok && Array.isArray(search.data) && search.data.length > 0);

const big = await call('prepare_purchase', { items: [{ product_id: process.env.SMOKE_PRODUCT_ID || 'c3-smoke-test', quantity: 11 }] }, 4);
check('quantity 11 is rejected', big.ok === false);

const unknown = await call('prepare_purchase', { items: [{ product_id: 'nope-123', quantity: 1 }] }, 5);
check('unknown product is rejected', unknown.ok === false);

const fake = await call('confirm_purchase', { quote_id: '00000000-0000-4000-8000-000000000000', confirmed_total: 1, user_said_yes: true }, 6);
check('confirm_purchase with a fake quote is refused', fake.ok === false);

const noYes = await call('confirm_purchase', { quote_id: '00000000-0000-4000-8000-000000000000', confirmed_total: 1, user_said_yes: false }, 7);
check('confirm_purchase without a yes is refused', noYes.ok === false && /yes/i.test(noYes.error));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
