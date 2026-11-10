import { db } from '../db.js';

export async function logTool(userId: string, tool: string, input: unknown, ok: boolean): Promise<void> {
  try {
    await db.from('mcp_tool_logs').insert({ user_id: userId, tool_name: tool, input: input ?? {}, ok });
  } catch {
    /* logging must never break a tool call */
  }
}
