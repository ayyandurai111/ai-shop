import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { need, opt } from './config.js';
import { UserError } from './errors.js';
import { TOOLS, runTool } from './tools.js';

const SYSTEM = `You are a friendly shopping assistant. The catalog is live product data from Channel3 (real retailers). You can search products and buy them using tools.
Rules:
- Use search_products to find items. Never invent products or prices; only use tool results.
- When the user wants to buy, call prepare_purchase, then show the items and the TOTAL (with currency) clearly and ask: "Shall I charge this total to your PayPal account? (yes/no)".
- Call confirm_purchase ONLY after the user has clearly said yes to that exact total in their latest message. Never guess. If they change anything, prepare a new quote.
- If the PayPal account is not linked, call link_paypal_account and give the user the approve_url (they open it once, with a sandbox buyer account).
- When you recommend or list specific products, end your reply with ONE final line exactly like: SHOW: c3-2yh8WH5, c3-9kQ1xLp (these are example ids) containing only the ids of the products you are recommending (best first, at most 4). The shop turns that line into product cards. Do not write the ids anywhere else in the text. If you recommend no product, do not write the line.
- Keep answers short and friendly. This is a sandbox demo: no real money moves and nothing is shipped.`;

// OpenAI-style tool list (Groq uses the OpenAI format).
const toolDefs = TOOLS.map((t) => {
  const schema: any = zodToJsonSchema(z.object(t.shape), { $refStrategy: 'none' });
  delete schema.$schema;
  return { type: 'function', function: { name: t.name, description: t.description, parameters: schema } };
});

// Extra code-level guard: confirm_purchase needs a plain "yes" style message from the human.
const AFFIRM = /\b(yes|yep|yeah|yup|ok|okay|sure|confirm|confirmed|go ahead|proceed|buy|pay|do it)\b|ஆம்|சரி/i;

function lastUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/**
 * History stays in the Anthropic block style (text / tool_use / tool_result), so chat.html needs no change.
 * Only at the edge we convert it to the OpenAI format that Groq expects, and convert the answer back.
 */
function toGroqMessages(messages: any[]): any[] {
  const out: any[] = [{ role: 'system', content: SYSTEM }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks: any[] = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg: any = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content ?? '').slice(0, 3000) });
        else if (b.type === 'text') out.push({ role: 'user', content: b.text });
      }
    }
  }
  return out;
}

function fromGroqMessage(msg: any): { content: any[]; stop_reason: string } {
  const content: any[] = [];
  if (typeof msg?.content === 'string' && msg.content.trim()) content.push({ type: 'text', text: msg.content });
  for (const c of msg?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(c.function?.arguments || '{}');
    } catch {
      /* bad JSON from the model: the tool will answer with a validation error and the model can retry */
    }
    content.push({ type: 'tool_use', id: String(c.id), name: String(c.function?.name ?? ''), input });
  }
  return { content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
}

async function callLLM(messages: any[], attempt = 0, rl = 0): Promise<any> {
  if (!opt('LLM_API_KEY')) throw new UserError('The AI is not configured: LLM_API_KEY is missing on the server.');
  const base = opt('LLM_BASE_URL', 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('LLM_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opt('LLM_MODEL', 'openai/gpt-oss-120b'),
      messages: toGroqMessages(messages),
      tools: toolDefs,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });
  if (res.status === 429) {
    // Free tier limits tokens per minute. Short waits are retried automatically; long ones are shown to the user.
    const wait = Math.ceil(Number(res.headers.get('retry-after')) || 0);
    console.error(`LLM rate limit (429), retry-after ${wait || '?'}s`);
    if (rl < 2 && wait > 0 && wait <= 20) {
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
      return callLLM(messages, attempt, rl + 1);
    }
    throw new UserError(`The free AI model is busy (rate limit). Wait ${wait > 0 ? `about ${wait} seconds` : 'a minute'} and try again.`);
  }
  if (res.status === 400 && attempt < 1) return callLLM(messages, attempt + 1, rl); // small models sometimes make a broken tool call: try once more
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    console.error(`LLM error HTTP ${res.status} (model ${opt('LLM_MODEL', 'openai/gpt-oss-120b')}):`, detail);
    if (res.status === 401 || res.status === 403)
      throw new UserError('The AI key (LLM_API_KEY) was rejected. Check that it is a valid Groq key on the server.');
    if (res.status === 404)
      throw new UserError('The AI model was not found. LLM_MODEL must be a Groq model such as openai/gpt-oss-120b.');
    throw new Error(`LLM request failed (HTTP ${res.status})`);
  }
  const j: any = await res.json();
  return fromGroqMessage(j.choices?.[0]?.message);
}

/** Cards must follow the AI's answer: only the products it recommends, not every search result. */
function pickProducts(reply: string, found: any[]): { text: string; products: any[] } {
  const m = reply.match(/^\s*SHOW:\s*(.*)$/im);
  const text = reply.replace(/^\s*SHOW:.*$/gim, '').trim();
  let picked: any[] = [];
  if (m) {
    const ids = m[1].split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    picked = ids.map((id) => found.find((p) => String(p.id).toLowerCase() === id)).filter(Boolean);
  }
  if (!picked.length) {
    const low = text.toLowerCase();
    picked = found.filter((p) => low.includes(String(p.name).toLowerCase()) || low.includes(String(p.id).toLowerCase()));
  }
  const seen = new Set<string>();
  const products = picked.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))).slice(0, 6);
  return { text, products };
}

export const ChatBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string().max(4000), z.array(z.any())]) }))
    .min(1)
    .max(80),
});

export async function runChat(userId: string, history: any[]) {
  let messages = history.slice(-16);
  while (messages.length && !(messages[0].role === 'user' && typeof messages[0].content === 'string')) messages.shift();
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || typeof last.content !== 'string') {
    throw new Error('The last message must be a text message from the user.');
  }

  const products: any[] = [];
  let quoted = false;
  for (let i = 0; i < 8; i++) {
    const r = await callLLM(messages);
    messages.push({ role: 'assistant', content: r.content });
    if (r.stop_reason !== 'tool_use') {
      const raw = (r.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const { text, products: shown } = pickProducts(raw, products);
      // No cards while a quote or payment is being confirmed: the total in the text is what matters.
      return { reply: text || '...', products: quoted ? [] : shown, messages };
    }
    const results: any[] = [];
    for (const b of r.content as any[]) {
      if (b.type !== 'tool_use') continue;
      const out =
        b.name === 'confirm_purchase' && !AFFIRM.test(lastUserText(messages))
          ? { ok: false as const, error: 'Refused: the user has not clearly said yes in their latest message. Show the total and ask for a yes first.' }
          : await runTool(userId, b.name, b.input);
      if (b.name === 'prepare_purchase' || b.name === 'confirm_purchase') quoted = true;
      if (out.ok && (b.name === 'search_products' || b.name === 'get_product')) {
        const d: any = out.data;
        for (const p of Array.isArray(d) ? d : [d]) if (p?.id && !products.some((x) => x.id === p.id)) products.push(p);
      }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out), is_error: !out.ok });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'Sorry, I got stuck. Please try again.', products, messages };
}
