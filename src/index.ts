import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createObsidianServer } from './server.js';
import { VaultConfig } from './types.js';

function parseCliArgs(): VaultConfig {
  const args = process.argv.slice(2);
  let vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
  let allowedSubpaths: string[] | undefined = process.env.OBSIDIAN_ALLOWED_SUBPATHS
    ? process.env.OBSIDIAN_ALLOWED_SUBPATHS.split(',').map((s) => s.trim())
    : undefined;
  let readOnly = process.env.OBSIDIAN_READONLY === 'true';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--vault' || arg === '-v') {
      vaultPath = args[++i];
    } else if (arg === '--subpaths' || arg === '-s') {
      allowedSubpaths = args[++i].split(',').map((s) => s.trim());
    } else if (arg === '--readonly' || arg === '-r') {
      readOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Obsidian AGI Workspace MCP Server

Usage:
  obsidian-agi-workspace-mcp [options]

Options:
  -v, --vault <path>       Absolute path to the Obsidian vault root (or $OBSIDIAN_VAULT_PATH)
  -s, --subpaths <list>    Comma-separated list of allowed relative subdirectories
  -r, --readonly           Enable read-only mode (prevent modifications)
  -h, --help               Show this help message

Environment Variables:
  OBSIDIAN_VAULT_PATH          Target vault root path
  OBSIDIAN_ALLOWED_SUBPATHS    Comma-separated list of allowed subdirectories
  OBSIDIAN_READONLY            Set to 'true' for read-only mode
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
  };
}

async function main() {
  const config = parseCliArgs();
  const { server } = createObsidianServer(config);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(`[obsidian-agi-workspace-mcp] Connected to vault: ${config.vaultPath}`);
}

main().catch((err) => {
  console.error('[obsidian-agi-workspace-mcp] Fatal error:', err);
  process.exit(1);
});
