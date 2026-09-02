import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createObsidianServer } from './server.js';
import { createWorkspaceHttpServer } from './httpServer.js';
import { VaultConfig } from './types.js';

function readSecret(
  env: Record<string, string | undefined>,
  valueName: string,
  fileName: string,
): string | undefined {
  const direct = env[valueName]?.trim();
  if (direct) return direct;
  const secretPath = env[fileName];
  if (!secretPath) return undefined;
  return fs.readFileSync(secretPath, 'utf8').trim();
}

export function parseCliArgs(
  args: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): VaultConfig {
  let vaultPath = env.OBSIDIAN_VAULT_PATH || '';
  let allowedSubpaths: string[] | undefined = env.OBSIDIAN_ALLOWED_SUBPATHS
    ? env.OBSIDIAN_ALLOWED_SUBPATHS.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  let readOnly = env.OBSIDIAN_READONLY === 'true';
  const configuredTransport = env.MCP_TRANSPORT || 'stdio';
  let transport: 'stdio' | 'streamable-http' =
    configuredTransport === 'http' ? 'streamable-http' : (configuredTransport as any);
  let port = env.PORT ? parseInt(env.PORT, 10) : 8080;
  let host = env.HOST || '0.0.0.0';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--vault' || arg === '-v') {
      vaultPath = args[++i];
    } else if (arg === '--subpaths' || arg === '-s') {
      allowedSubpaths = args[++i].split(',').map((s) => s.trim());
    } else if (arg === '--readonly' || arg === '-r') {
      readOnly = true;
    } else if (arg === '--transport' || arg === '-t') {
      const requested = args[++i];
      transport = requested === 'http' ? 'streamable-http' : (requested as any);
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
  -t, --transport <mode>   Transport mode: 'stdio' (default) or 'streamable-http'
  -p, --port <port>        Streamable HTTP server port (default: 8080 or $PORT)
  --host <host>            Streamable HTTP bind host (default: 0.0.0.0 or $HOST)
  -h, --help               Show this help message

Environment Variables:
  OBSIDIAN_VAULT_PATH          Target vault root path
  OBSIDIAN_ALLOWED_SUBPATHS    Comma-separated list of allowed subdirectories
  OBSIDIAN_READONLY            Set to 'true' for read-only mode
  MCP_TRANSPORT                'stdio' or 'streamable-http' ('http' is an alias)
  MCP_AUTH_TOKEN[_FILE]        Bearer token or mounted secret file for HTTP mode
  MCP_ALLOWED_HOSTS            Comma-separated HTTP Host allowlist
  X_PUBLISH_QUEUE_PATH         Sync-safe queue path; enables X preview/request/status tools
  PORT                         Streamable HTTP server port
  HOST                         Streamable HTTP bind host
`);
      process.exit(0);
    } else if (!vaultPath && !arg.startsWith('-')) {
      vaultPath = arg;
    }
  }

  if (!vaultPath) {
    throw new Error(
      'Vault path must be specified via --vault <path> or OBSIDIAN_VAULT_PATH environment variable.'
    );
  }

  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw new Error("Transport must be 'stdio' or 'streamable-http'. Legacy SSE is not supported.");
  }

  return {
    vaultPath,
    allowedSubpaths,
    readOnly,
    transport,
    port,
    host,
    authToken: readSecret(env, 'MCP_AUTH_TOKEN', 'MCP_AUTH_TOKEN_FILE'),
    allowedHosts: env.MCP_ALLOWED_HOSTS
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    maxBodyBytes: env.MCP_MAX_BODY_BYTES ? parseInt(env.MCP_MAX_BODY_BYTES, 10) : undefined,
    xPublishQueuePath: env.X_PUBLISH_QUEUE_PATH?.trim() || undefined,
  };
}

async function startStdio(config: VaultConfig) {
  const { server } = createObsidianServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[obsidian-agi-workspace-mcp] Connected via STDIO to vault: ${config.vaultPath}`);
}

async function startHttp(config: VaultConfig) {
  const port = config.port || 8080;
  const host = config.host || '0.0.0.0';
  const httpServer = await createWorkspaceHttpServer(config);

  httpServer.listen(port, host, () => {
    console.error(
      `[obsidian-agi-workspace-mcp] Streamable HTTP server running at http://${host}:${port}/mcp`
    );
  });
}

async function main() {
  const config = parseCliArgs();

  if (config.transport === 'streamable-http') {
    await startHttp(config);
  } else {
    await startStdio(config);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((err) => {
    console.error('[obsidian-agi-workspace-mcp] Fatal error:', err);
    process.exit(1);
  });
}
