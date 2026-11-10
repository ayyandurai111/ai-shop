import { db } from '../db.js';
import { UserError } from '../errors.js';
import { getDispute as ppGetDispute, listDisputes as ppListDisputes } from '../paypal.js';

async function myCaptureIds(userId: string): Promise<Set<string>> {
  const { data } = await db.from('orders').select('capture_id').eq('user_id', userId).not('capture_id', 'is', null);
  return new Set((data ?? []).map((o: any) => o.capture_id as string));
}

const txIds = (d: any): string[] => (d?.disputed_transactions ?? []).map((t: any) => t.seller_transaction_id).filter(Boolean);

const summary = (d: any) => ({
  dispute_id: d.dispute_id,
  status: d.status,
  reason: d.reason,
  amount: d.dispute_amount,
  created: d.create_time,
  updated: d.update_time,
  outcome: d.dispute_outcome?.outcome_code ?? null,
});

/** Read-only. Only disputes that belong to the user's own captured payments are returned. */
export async function listDisputes(userId: string, limit = 10) {
  const mine = await myCaptureIds(userId);
  if (mine.size === 0) return [];
  const list = await ppListDisputes(25);
  const out: any[] = [];
  for (const item of list.items ?? []) {
    if (out.length >= limit) break;
    const full = txIds(item).length ? item : await ppGetDispute(item.dispute_id);
    if (txIds(full).some((id) => mine.has(id))) out.push(summary(full));
  }
  return out;
}

export async function getDispute(userId: string, disputeId: string) {
  const d = await ppGetDispute(disputeId);
  const mine = await myCaptureIds(userId);
  if (!txIds(d).some((id) => mine.has(id))) throw new UserError('Dispute not found.');
  return { ...summary(d), messages: (d.messages ?? []).slice(-5).map((m: any) => ({ posted_by: m.posted_by, time: m.time_posted, content: m.content })) };
}
