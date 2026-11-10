import { db } from '../db.js';
import { UserError } from '../errors.js';
import { createPaymentToken, createSetupToken, deletePaymentToken } from '../paypal.js';

const now = (): string => new Date().toISOString();

async function getRow(userId: string): Promise<any | null> {
  const { data, error } = await db.from('paypal_accounts').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function startLinking(userId: string) {
  const row = await getRow(userId);
  if (row?.status === 'ACTIVE') return { status: 'ACTIVE', message: 'A PayPal account is already linked.' };
  const { setupTokenId, approveUrl } = await createSetupToken(userId);
  const { error } = await db.from('paypal_accounts').upsert({
    user_id: userId,
    setup_token_id: setupTokenId,
    payment_token_id: null,
    vault_customer_id: null,
    status: 'PENDING',
    updated_at: now(),
  });
  if (error) throw new Error(error.message);
  return {
    status: 'PENDING',
    approve_url: approveUrl,
    message: 'Open approve_url once in a browser and approve with a PayPal SANDBOX buyer account. No card is needed.',
  };
}

export async function completeLinking(userId: string) {
  const row = await getRow(userId);
  if (row?.status === 'ACTIVE') return { status: 'ACTIVE' };
  if (!row || row.status !== 'PENDING' || !row.setup_token_id) {
    throw new UserError('No linking in progress. Start with link_paypal_account.');
  }
  let created;
  try {
    created = await createPaymentToken(row.setup_token_id);
  } catch (e) {
    throw new UserError(`PayPal approval is not finished yet. Open the approve link and approve first. ${(e as Error).message}`);
  }
  const { error } = await db
    .from('paypal_accounts')
    .update({ payment_token_id: created.paymentTokenId, vault_customer_id: created.customerId, status: 'ACTIVE', updated_at: now() })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return { status: 'ACTIVE' };
}

export async function getLinkStatus(userId: string) {
  let row = await getRow(userId);
  if (row?.status === 'PENDING') {
    try {
      await completeLinking(userId); // picks up an approval that already happened
      row = await getRow(userId);
    } catch {
      /* still pending */
    }
  }
  const status = row?.status ?? 'NONE';
  return { status, linked: status === 'ACTIVE' };
}

export async function unlinkAccount(userId: string) {
  const row = await getRow(userId);
  if (!row || row.status === 'REMOVED') return { status: 'REMOVED', message: 'No PayPal account is linked.' };
  if (row.payment_token_id) {
    try {
      await deletePaymentToken(row.payment_token_id);
    } catch (e) {
      if (!/404|RESOURCE_NOT_FOUND/i.test((e as Error).message)) throw e;
    }
  }
  await db
    .from('paypal_accounts')
    .update({ status: 'REMOVED', payment_token_id: null, setup_token_id: null, updated_at: now() })
    .eq('user_id', userId);
  return { status: 'REMOVED' };
}

/** Internal only. The token id never leaves the backend. */
export async function getActivePaymentToken(userId: string): Promise<string | null> {
  const row = await getRow(userId);
  return row?.status === 'ACTIVE' && row.payment_token_id ? row.payment_token_id : null;
}
