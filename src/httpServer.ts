import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createObsidianServer } from './server.js';
import { VaultConfig } from './types.js';

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided?.startsWith('Bearer ')) return false;
  const suppliedToken = provided.slice('Bearer '.length);
  const suppliedHash = crypto.createHash('sha256').update(suppliedToken).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(suppliedHash, expectedHash);
}

function requestHost(req: IncomingMessage): string {
  const authority = req.headers.host ?? '';
  if (authority.startsWith('[')) return authority.slice(1, authority.indexOf(']'));
  return authority.split(':')[0];
}

export async function createWorkspaceHttpServer(config: VaultConfig): Promise<http.Server> {
  const authToken = config.authToken?.trim();
  if (!authToken) {
    throw new Error('MCP auth token is required for Streamable HTTP transport.');
  }
  if (authToken.length < 24) {
    throw new Error('MCP auth token must contain at least 24 characters.');
  }

  const allowedHosts = config.allowedHosts?.filter(Boolean) ?? ['127.0.0.1', 'localhost', '::1'];
  if (allowedHosts.length === 0) {
    throw new Error('At least one MCP allowed host is required.');
  }

  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.includes(requestHost(req))) {
        json(res, 421, { error: 'Misdirected Request' });
        return;
      }

      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { status: 'ok' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/readyz') {
        try {
          await fs.access(config.vaultPath);
          json(res, 200, { status: 'ready' });
        } catch {
          json(res, 503, { status: 'not-ready' });
        }
        return;
      }

      if (url.pathname !== '/mcp') {
        json(res, 404, { error: 'Not Found' });
        return;
      }

      if (!tokenMatches(req.headers.authorization, authToken)) {
        res.setHeader('www-authenticate', 'Bearer');
        json(res, 401, { error: 'Unauthorized' });
        return;
      }

      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
        json(res, 413, { error: 'Payload Too Large' });
        return;
      }

      const { server: mcpServer } = createObsidianServer(config);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcpServer.connect(transport);
      try {
        await transport.handleRequest(req, res);
      } finally {
        await transport.close();
      }
    } catch (error) {
      if (!res.headersSent) {
        json(res, 500, { error: 'Internal Server Error' });
      } else {
        res.end();
      }
      console.error('[workspace-mcp] HTTP request failed:', error);
    }
  });

  return httpServer;
}
