// A small MCP server for tests: `node mcp-server.js` speaks stdio; require() it for createServer().
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

function createServer() {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echo the text back', inputSchema: { text: z.string(), times: z.number().int().optional() } },
    async ({ text, times = 1 }) => ({ content: [{ type: 'text', text: text.repeat(times) }] })
  );
  server.registerTool('fail', { description: 'Always fails', inputSchema: {} }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'it broke' }],
  }));
  server.registerTool('structured', { description: 'Structured output only', inputSchema: {} }, async () => ({
    content: [],
    structuredContent: { ok: true },
  }));
  return server;
}

module.exports = { createServer };

if (require.main === module) createServer().connect(new StdioServerTransport());
