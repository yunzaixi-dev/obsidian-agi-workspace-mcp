import http from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createObsidianServer } from './server.js';
import { VaultConfig } from './types.js';

function parseCliArgs(): VaultConfig {
  const args = process.argv.slice(2);
  let vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
  let allowedSubpaths: string[] | undefined = process.env.OBSIDIAN_ALLOWED_SUBPATHS
    ? process.env.OBSIDIAN_ALLOWED_SUBPATHS.split(',').map((s) => s.trim())
    : undefined;
  let readOnly = process.env.OBSIDIAN_READONLY === 'true';
  let transport: 'stdio' | 'sse' | 'http' = (process.env.MCP_TRANSPORT as any) || 'stdio';
  let port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
  let host = process.env.HOST || '0.0.0.0';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--vault' || arg === '-v') {
      vaultPath = args[++i];
    } else if (arg === '--subpaths' || arg === '-s') {
      allowedSubpaths = args[++i].split(',').map((s) => s.trim());
    } else if (arg === '--readonly' || arg === '-r') {
      readOnly = true;
    } else if (arg === '--transport' || arg === '-t') {
      transport = args[++i] as any;
    } else if (arg === '--port' || arg === '-p') {
      port = parseInt(args[++i], 10);
    } else if (arg === '--host') {
      host = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Obsidian AGI Workspace MCP Server

Usage:
  obsidian-agi-workspace-mcp [options]

Options:
  -v, --vault <path>       Absolute path to the Obsidian vault root (or $OBSIDIAN_VAULT_PATH)
  -s, --subpaths <list>    Comma-separated list of allowed relative subdirectories
  -r, --readonly           Enable read-only mode (prevent modifications)
  -t, --transport <mode>   Transport mode: 'stdio' (default) or 'sse' / 'http'
  -p, --port <port>        HTTP/SSE server port (default: 8080 or $PORT)
  --host <host>            HTTP/SSE server bind host (default: 0.0.0.0 or $HOST)
  -h, --help               Show this help message

Environment Variables:
  OBSIDIAN_VAULT_PATH          Target vault root path
  OBSIDIAN_ALLOWED_SUBPATHS    Comma-separated list of allowed subdirectories
  OBSIDIAN_READONLY            Set to 'true' for read-only mode
  MCP_TRANSPORT                'stdio' or 'sse'
  PORT                         Port number for SSE/HTTP server
  HOST                         Bind host for SSE/HTTP server
`);
      process.exit(0);
    } else if (!vaultPath && !arg.startsWith('-')) {
      vaultPath = arg;
    }
  }

  if (!vaultPath) {
    console.error(
      'Error: Vault path must be specified via --vault <path> or OBSIDIAN_VAULT_PATH environment variable.'
    );
    process.exit(1);
  }

  return {
    vaultPath,
    allowedSubpaths,
    readOnly,
    transport,
    port,
    host,
  };
}

async function startStdio(config: VaultConfig) {
  const { server } = createObsidianServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[obsidian-agi-workspace-mcp] Connected via STDIO to vault: ${config.vaultPath}`);
}

async function startSSE(config: VaultConfig) {
  const port = config.port || 8080;
  const host = config.host || '0.0.0.0';

  // Map to store active SSE transports per session
  const sseTransports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // CORS Headers for cluster & remote clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health & readiness probes for Kubernetes
    if (url.pathname === '/healthz' || url.pathname === '/readyz' || url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          vault: config.vaultPath,
          readOnly: config.readOnly,
          uptime: process.uptime(),
        })
      );
      return;
    }

    // SSE connection endpoint: GET /sse
    if (req.method === 'GET' && url.pathname === '/sse') {
      const sseTransport = new SSEServerTransport('/messages', res);
      const { server } = createObsidianServer(config);

      const sessionId = sseTransport.sessionId;
      sseTransports.set(sessionId, sseTransport);

      sseTransport.onclose = () => {
        sseTransports.delete(sessionId);
        console.error(`[obsidian-agi-workspace-mcp] Closed SSE session: ${sessionId}`);
      };

      await server.connect(sseTransport);
      console.error(`[obsidian-agi-workspace-mcp] Started SSE session: ${sessionId}`);
      return;
    }

    // Client message endpoint: POST /messages?sessionId=...
    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || !sseTransports.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing sessionId' }));
        return;
      }

      const sseTransport = sseTransports.get(sessionId)!;
      await sseTransport.handlePostMessage(req, res);
      return;
    }

    // Fallback 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  httpServer.listen(port, host, () => {
    console.error(
      `[obsidian-agi-workspace-mcp] Server running at http://${host}:${port} (SSE: /sse, Health: /healthz)`
    );
    console.error(`[obsidian-agi-workspace-mcp] Mounted vault: ${config.vaultPath}`);
  });
}

async function main() {
  const config = parseCliArgs();

  if (config.transport === 'sse' || config.transport === 'http') {
    await startSSE(config);
  } else {
    await startStdio(config);
  }
}

main().catch((err) => {
  console.error('[obsidian-agi-workspace-mcp] Fatal error:', err);
  process.exit(1);
});
