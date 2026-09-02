import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkspaceHttpServer } from '../src/httpServer.js';

const TEST_TOKEN = 'test-only-mcp-token-with-enough-entropy';

describe('authenticated Streamable HTTP transport', () => {
  let vaultPath: string;
  let server: http.Server;
  let baseUrl: URL;

  beforeEach(async () => {
    vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-http-'));
    await fs.writeFile(path.join(vaultPath, 'hello.md'), '# Hello');
    await fs.mkdir(path.join(vaultPath, 'docs/blogs'), { recursive: true });
    await fs.writeFile(path.join(vaultPath, 'docs/blogs/article.md'), '# Article\n\nSafe body');
    server = await createWorkspaceHttpServer({
      vaultPath,
      transport: 'streamable-http',
      authToken: TEST_TOKEN,
      allowedHosts: ['127.0.0.1'],
      xPublishQueuePath: 'docs/blogs/.x-publish',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    await fs.rm(vaultPath, { recursive: true, force: true });
  });

  it('rejects unauthenticated MCP requests before parsing them', async () => {
    const response = await fetch(new URL('/mcp', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('serves sanitized health information without authentication', async () => {
    const response = await fetch(new URL('/healthz', baseUrl));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
    expect(JSON.stringify(body)).not.toContain(vaultPath);
  });

  it('rejects host headers outside the configured allowlist', async () => {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request(
        new URL('/healthz', baseUrl),
        { headers: { host: 'attacker.example' } },
        resolve
      );
      request.on('error', reject);
      request.end();
    });
    response.resume();
    expect(response.statusCode).toBe(421);
  });

  it('allows an authenticated official MCP client to list tools', async () => {
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    });

    try {
      await client.connect(transport);
      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name);
      expect(names).toContain('read_note');
      expect(names).not.toContain('sync_vault_ob');
    } finally {
      await client.close();
    }
  });

  it('preserves an externally synced note when write_note receives a stale hash', async () => {
    const client = new Client({ name: 'hash-integration-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    });

    try {
      await client.connect(transport);
      const readResult = await client.callTool({
        name: 'read_note',
        arguments: { pathOrTitle: 'hello.md' },
      });
      const readText = (readResult.content as Array<{ type: 'text'; text: string }>)[0].text;
      const note = JSON.parse(readText) as { sourceSha256: string };

      const syncedContent = '# Changed by ob\n';
      await fs.writeFile(path.join(vaultPath, 'hello.md'), syncedContent, 'utf8');
      const writeResult = await client.callTool({
        name: 'write_note',
        arguments: {
          path: 'hello.md',
          body: '# Stale Agent edit\n',
          overwrite: true,
          expectedSha256: note.sourceSha256,
        },
      });

      expect(writeResult.isError).toBe(true);
      expect(await fs.readFile(path.join(vaultPath, 'hello.md'), 'utf8')).toBe(syncedContent);
    } finally {
      await client.close();
    }
  });

  it('previews, requests, and reads X publication status without publishing remotely', async () => {
    const client = new Client({ name: 'x-integration-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    });

    try {
      await client.connect(transport);
      const previewResult = await client.callTool({
        name: 'render_x_preview',
        arguments: { sourcePath: 'docs/blogs/article.md' },
      });
      const preview = JSON.parse((previewResult.content as Array<{ text: string }>)[0].text);
      expect(preview).toMatchObject({ title: 'Article', bodyChars: 9 });

      const requestResult = await client.callTool({
        name: 'request_x_publish',
        arguments: { sourcePath: 'docs/blogs/article.md', targetAccount: '@yunzaixi' },
      });
      const requested = JSON.parse((requestResult.content as Array<{ text: string }>)[0].text);
      expect(requested.request.sourceSha256).toBe(preview.sourceSha256);

      const statusResult = await client.callTool({
        name: 'get_x_publication_status',
        arguments: { requestId: requested.request.requestId },
      });
      const status = JSON.parse((statusResult.content as Array<{ text: string }>)[0].text);
      expect(status.status).toBe('requested');
    } finally {
      await client.close();
    }
  });
});

describe('Streamable HTTP configuration', () => {
  it('fails closed when no authentication token is configured', async () => {
    await expect(
      createWorkspaceHttpServer({ vaultPath: '/tmp', transport: 'streamable-http' })
    ).rejects.toThrow(/auth token/i);
  });
});
