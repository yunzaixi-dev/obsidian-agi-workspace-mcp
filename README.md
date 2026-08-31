# obsidian-agi-workspace-mcp

> **Model Context Protocol (MCP) Server for Obsidian Vaults**  
> Turn your personal or collaborative Obsidian Vault into a persistent, bidirectional, and structured knowledge workspace for AGI agents (Claude Code, Codex, Hermes Agent, Cursor, VS Code ACP, and Roo-Cline).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![MCP Spec](https://img.shields.io/badge/MCP-1.30-purple.svg)](https://modelcontextprotocol.io/)

---

## 🌟 Highlights

- **🧠 Bi-directional Wikilink & Backlink Resolution**: Automatically detects `[[Wikilinks]]`, resolves target notes, maintains live backlink graphs, and discovers orphan notes and broken/dangling links.
- **🏷️ Structured Frontmatter & Tag Indexing**: Full YAML frontmatter parsing, tag clustering (with support for `#nested/tags` and Unicode/Chinese tags), and exact frontmatter metadata filtering.
- **📁 Directory & Hierarchy Management**: Dedicated tools for folder creation (`create_folder`), directory listing (`list_folders`), and recursive tree inspection (`get_vault_tree`).
- **🛡️ Sandbox & Path Traversal Security**: Strict root path boundary enforcement, jail containment, and optional `allowedSubpaths` configuration (ideal for exposing only designated vault subdirectories).
- **📝 Fine-Grained Note Patching**: Append, prepend, regular-expression targeted replacements, frontmatter merging, and hierarchical markdown section replacement (e.g. updating a `## Tasks` section without touching the rest of the note).
- **✅ Cross-Vault Task Aggregation**: Automatically extracts markdown checklist items (`- [ ]` / `- [x]`) across notes with line tracking and status filters.
- **⚡ High Performance & Zero Heavy Overhead**: Built with TypeScript, fast-glob, and gray-matter for instant indexing and minimal memory footprint.

---

## 🚀 Quick Start

### 1. Installation

You can install globally or run directly via `npx`:

```bash
# Global installation via npm/pnpm
npm install -g obsidian-agi-workspace-mcp
# or
pnpm add -g obsidian-agi-workspace-mcp
```

### 2. Configuration for MCP Clients

#### **Claude Desktop (`claude_desktop_config.json`)**
```json
{
  "mcpServers": {
    "obsidian-workspace": {
      "command": "npx",
      "args": ["-y", "obsidian-agi-workspace-mcp"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/Users/username/Documents/Obsidian Vault",
        "OBSIDIAN_ALLOWED_SUBPATHS": "vault,projects,research"
      }
    }
  }
}
```

#### **Hermes Agent (`~/.hermes/config.yaml`)**
```yaml
mcp_servers:
  obsidian-workspace:
    command: npx
    args: ["-y", "obsidian-agi-workspace-mcp"]
    env:
      OBSIDIAN_VAULT_PATH: "/home/yun/Desktop/docs/vault"
```

#### **Cursor / VS Code MCP Extension**
Add to your project's `.cursor/mcp.json` or global configuration:
```json
{
  "mcpServers": {
    "obsidian-workspace": {
      "command": "node",
      "args": ["/path/to/obsidian-agi-workspace-mcp/dist/index.js", "--vault", "/path/to/your/vault"]
    }
  }
}
```

---

## 🛠️ Available MCP Tools

| Tool | Parameters | Description |
|---|---|---|
| `search_vault` | `query`, `tags`, `frontmatterFilter`, `folder`, `limit`, `offset` | Search notes by full-text keywords, tag matches (e.g. `["#tju", "ops"]`), frontmatter fields, or folder boundaries. |
| `read_note` | `pathOrTitle` | Read note content with YAML frontmatter, raw body, metadata, outgoing wikilinks, and incoming backlinks. Supports both relative paths and wikilink titles. |
| `write_note` | `path`, `body`, `frontmatter`, `overwrite` | Create or update a note with structured YAML frontmatter and markdown body. Auto-creates intermediate directories. |
| `patch_note` | `path`, `append`, `prepend`, `replaceSection`, `patchRegex`, `updateFrontmatter` | Apply atomic or targeted edits (e.g. rewrite under a `## Heading`, append logs, or update frontmatter keys). |
| `create_folder` | `path` | Create a new folder or directory hierarchy inside the vault. |
| `list_folders` | `parentFolder` | List folder structures with relative paths and contained note counts. |
| `get_vault_tree` | `subfolder`, `maxDepth` | Retrieve hierarchical tree representation of notes and folders. |
| `list_tasks` | `completed`, `folder`, `tag` | Gather all markdown task checkboxes (`- [ ]` / `- [x]`) across the vault with line number coordinates. |
| `analyze_workspace_graph` | _None_ | Analyze topological note connections, count nodes/edges, and identify orphan notes and broken wikilinks. |
| `delete_item` | `path`, `permanent` | Safely remove a note or folder (moves to `.trash` by default unless `permanent=true`). |

---

## ⚙️ Environment Variables & CLI Flags

| CLI Flag | Env Variable | Default | Description |
|---|---|---|---|
| `-v, --vault <path>` | `OBSIDIAN_VAULT_PATH` | _Required_ | Absolute filesystem path to the Obsidian vault root |
| `-s, --subpaths <list>`| `OBSIDIAN_ALLOWED_SUBPATHS`| `None` (Full vault) | Comma-separated list of permitted relative subfolders |
| `-r, --readonly` | `OBSIDIAN_READONLY` | `false` | When `true`, rejects note creation, edits, and deletions |

---

## 🧑‍💻 Development & Testing

This project uses [go-task](https://taskfile.dev/) and `pnpm`:

```bash
# Clone repository
git clone https://github.com/yunzaixi-dev/obsidian-agi-workspace-mcp.git
cd obsidian-agi-workspace-mcp

# Install dependencies
pnpm install

# Run typechecks, unit tests & build
task check

# Start in development mode
task dev -- --vault /path/to/vault
```

---

## 📄 License

[MIT License](LICENSE) © 2026 [yunzaixi-dev](https://github.com/yunzaixi-dev)
