import { createClient } from '@supabase/supabase-js';
import { need } from './config.js';

// Service-role client: backend only. Never sent to the browser.
export const db = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
