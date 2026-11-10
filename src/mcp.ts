import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOLS, runTool } from './tools.js';

/** A fresh server per request (stateless). Every tool runs as the authenticated user. */
export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: 'ai-shop-paypal-demo', version: '1.0.0' });
  for (const t of TOOLS) {
    // Cast: tool shapes are dynamic, so the SDK's generic types cannot follow them.
    (server as any).registerTool(
      t.name,
      { description: t.description, inputSchema: t.shape },
      async (args: unknown) => {
        const r = await runTool(userId, t.name, args);
        return { content: [{ type: 'text', text: JSON.stringify(r) }], isError: !r.ok };
      },
    );
  }
  return server;
}
