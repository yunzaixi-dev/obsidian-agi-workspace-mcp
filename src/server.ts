import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VaultManager } from './vault.js';
import { VaultConfig } from './types.js';
import { ObSyncManager } from './obSync.js';

export function createObsidianServer(config: VaultConfig) {
  const vault = new VaultManager(config);
  const obSync = new ObSyncManager(config.vaultPath);

  const server = new McpServer({
    name: 'obsidian-agi-workspace-mcp',
    version: '0.1.0',
  });

  // Tool: create_folder
  server.tool(
    'create_folder',
    'Create a new folder or directory hierarchy inside the Obsidian vault.',
    {
      path: z.string().describe('Relative folder path to create (e.g. "projects/agi" or "vault/ops/cluster-health")'),
    },
    async ({ path }) => {
      try {
        const result = await vault.createFolder(path);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, folder: result.relativePath, fullPath: result.fullPath }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error creating folder: ${err.message}` }],
        };
      }
    }
  );

  // Tool: list_folders
  server.tool(
    'list_folders',
    'List folders and directory structure in the vault with note counts.',
    {
      parentFolder: z.string().optional().describe('Filter by parent directory path (e.g. "projects" or "vault/tju")'),
    },
    async ({ parentFolder }) => {
      try {
        const folders = await vault.listFolders(parentFolder);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: folders.length, folders }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error listing folders: ${err.message}` }],
        };
      }
    }
  );

  // Tool: get_vault_tree
  server.tool(
    'get_vault_tree',
    'Retrieve hierarchical directory tree of folders and notes in the vault for workspace overview.',
    {
      subfolder: z.string().optional().describe('Scope tree overview to a subfolder'),
      maxDepth: z.number().optional().describe('Maximum folder traversal depth (default: 5)'),
    },
    async ({ subfolder, maxDepth }) => {
      try {
        const tree = await vault.getVaultTree(subfolder, maxDepth);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tree, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error retrieving vault tree: ${err.message}` }],
        };
      }
    }
  );

  // Tool: read_note
  server.tool(
    'read_note',
    'Read an Obsidian note with frontmatter, body, metadata, wikilinks, and backlinks.',
    {
      pathOrTitle: z.string().describe('Relative path (e.g. "ops/cluster.md") or note title / wikilink target (e.g. "Cluster Health")'),
    },
    async ({ pathOrTitle }) => {
      try {
        const note = await vault.getNote(pathOrTitle);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(note, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error reading note: ${err.message}` }],
        };
      }
    }
  );

  // Tool: write_note
  server.tool(
    'write_note',
    'Create or overwrite a note in the Obsidian vault with structured YAML frontmatter and body.',
    {
      path: z.string().describe('Relative note path (e.g. "projects/agi-workspace.md")'),
      body: z.string().describe('Markdown body text'),
      frontmatter: z.record(z.string(), z.any()).optional().describe('YAML frontmatter key-value pairs (tags, aliases, status, etc.)'),
      overwrite: z.boolean().optional().describe('Whether to overwrite if file exists (default: true)'),
    },
    async ({ path, body, frontmatter, overwrite }) => {
      try {
        const meta = await vault.writeNote(path, body, frontmatter, { overwrite });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, metadata: meta }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error writing note: ${err.message}` }],
        };
      }
    }
  );

  // Tool: patch_note
  server.tool(
    'patch_note',
    'Perform fine-grained updates on an existing Obsidian note (append, prepend, replace under heading, regex patch, update frontmatter).',
    {
      path: z.string().describe('Relative note path or title'),
      append: z.string().optional().describe('Text to append to the end of the note body'),
      prepend: z.string().optional().describe('Text to prepend to the beginning of the note body'),
      replaceSection: z
        .object({
          heading: z.string().describe('Heading text to match (e.g. "Tasks" or "## Notes")'),
          content: z.string().describe('New content for this section including heading or markdown text'),
        })
        .optional()
        .describe('Replace or add an entire markdown heading section'),
      patchRegex: z
        .object({
          pattern: z.string().describe('Regular expression pattern'),
          replacement: z.string().describe('Replacement text'),
          flags: z.string().optional().describe('Regex flags (default: g)'),
        })
        .optional()
        .describe('Regex-based targeted substitution'),
      updateFrontmatter: z
        .record(z.string(), z.any())
        .optional()
        .describe('Frontmatter keys to merge or update'),
    },
    async ({ path, append, prepend, replaceSection, patchRegex, updateFrontmatter }) => {
      try {
        const meta = await vault.patchNote(path, {
          append,
          prepend,
          replaceSection,
          patchRegex,
          updateFrontmatter,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, metadata: meta }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error patching note: ${err.message}` }],
        };
      }
    }
  );

  // Tool: search_vault
  server.tool(
    'search_vault',
    'Search vault notes by keyword, tags, frontmatter filters, or directory subpath.',
    {
      query: z.string().optional().describe('Full-text or title search keyword'),
      tags: z.array(z.string()).optional().describe('Filter by one or more tags (e.g. ["#tju", "ops"])'),
      frontmatterFilter: z.record(z.string(), z.any()).optional().describe('Filter notes having exact frontmatter key-value matches'),
      folder: z.string().optional().describe('Restrict search to a specific relative subfolder'),
      limit: z.number().optional().describe('Max results to return (default: 50)'),
      offset: z.number().optional().describe('Pagination offset (default: 0)'),
    },
    async (options) => {
      try {
        const results = await vault.searchNotes(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: results.length, results }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error searching vault: ${err.message}` }],
        };
      }
    }
  );

  // Tool: list_tasks
  server.tool(
    'list_tasks',
    'Aggregate markdown task checkboxes (- [ ] / - [x]) across the Obsidian vault.',
    {
      completed: z.boolean().optional().describe('Filter by task completion state (true for [x], false for [ ])'),
      folder: z.string().optional().describe('Scope to a specific subfolder'),
      tag: z.string().optional().describe('Scope to notes with a specific tag'),
    },
    async (options) => {
      try {
        const tasks = await vault.getTasks(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: tasks.length, tasks }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error fetching tasks: ${err.message}` }],
        };
      }
    }
  );

  // Tool: analyze_workspace_graph
  server.tool(
    'analyze_workspace_graph',
    'Analyze knowledge graph topology: nodes, wikilink edges, orphan notes, and dangling (broken) links.',
    {},
    async () => {
      try {
        const graph = await vault.getWorkspaceGraph();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  nodeCount: graph.nodes.length,
                  edgeCount: graph.edges.length,
                  orphanCount: graph.orphans.length,
                  danglingLinkCount: graph.danglingLinks.length,
                  orphans: graph.orphans,
                  danglingLinks: graph.danglingLinks,
                  nodes: graph.nodes.slice(0, 100),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error analyzing graph: ${err.message}` }],
        };
      }
    }
  );

  // Tool: sync_vault_ob
  server.tool(
    'sync_vault_ob',
    'Trigger an immediate Obsidian Sync cycle or inspect synchronization state via obsidian-headless (`ob`).',
    {
      action: z.enum(['status', 'sync', 'configure']).describe('Action to execute: "status", "sync", or "configure"'),
      mode: z.enum(['bidirectional', 'pull-only', 'mirror-remote']).optional().describe('Sync mode for configure action'),
      conflictStrategy: z.enum(['conflict', 'merge']).optional().describe('Conflict resolution strategy for configure action'),
    },
    async ({ action, mode, conflictStrategy }) => {
      try {
        if (action === 'status') {
          const status = await obSync.getSyncStatus();
          return {
            content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
          };
        } else if (action === 'sync') {
          const res = await obSync.triggerSync();
          return {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          };
        } else if (action === 'configure') {
          const res = await obSync.configureSync({ mode, conflictStrategy });
          return {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          };
        }
        throw new Error(`Unsupported sync action: ${action}`);
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error managing ob sync: ${err.message}` }],
        };
      }
    }
  );

  // Tool: delete_item
  server.tool(
    'delete_item',
    'Safely delete a note or folder (moves to .trash by default).',
    {
      path: z.string().describe('Relative note or folder path'),
      permanent: z.boolean().optional().describe('Permanently delete instead of moving to .trash (default: false)'),
    },
    async ({ path, permanent }) => {
      try {
        await vault.deleteItem(path, permanent);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, message: `Path '${path}' deleted.` }),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error deleting item: ${err.message}` }],
        };
      }
    }
  );

  return { server, vault, obSync };
}
