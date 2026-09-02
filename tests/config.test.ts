import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/index.js';

describe('CLI configuration', () => {
  it('maps legacy http to authenticated Streamable HTTP and enables the sync-safe X queue', () => {
    const config = parseCliArgs([], {
      OBSIDIAN_VAULT_PATH: '/vault',
      OBSIDIAN_ALLOWED_SUBPATHS: 'docs/blogs',
      MCP_TRANSPORT: 'http',
      MCP_AUTH_TOKEN: 'test-only-auth-token-with-enough-entropy',
      MCP_ALLOWED_HOSTS: 'mcp.internal,127.0.0.1',
      X_PUBLISH_QUEUE_PATH: 'docs/blogs/.x-publish',
    });

    expect(config).toMatchObject({
      vaultPath: '/vault',
      allowedSubpaths: ['docs/blogs'],
      transport: 'streamable-http',
      allowedHosts: ['mcp.internal', '127.0.0.1'],
      xPublishQueuePath: 'docs/blogs/.x-publish',
    });
  });

  it('rejects legacy SSE rather than silently exposing it', () => {
    expect(() =>
      parseCliArgs([], { OBSIDIAN_VAULT_PATH: '/vault', MCP_TRANSPORT: 'sse' }),
    ).toThrow(/Legacy SSE is not supported/);
  });
});
