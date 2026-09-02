import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { MarkdownParser } from '../src/parser.js';
import { VaultManager } from '../src/vault.js';

describe('MarkdownParser', () => {
  it('extracts wikilinks correctly', () => {
    const text = `
Here is a link to [[Second Brain]] and [[Projects/AGI Workspace|Our Workspace]].
Also check [[Research Notes#Section 1]].
`;
    const links = MarkdownParser.extractWikilinks(text);
    expect(links).toEqual(['Second Brain', 'Projects/AGI Workspace', 'Research Notes']);
  });

  it('extracts tags from frontmatter and body while ignoring code blocks', () => {
    const text = `---
tags: [agi, mcp/workspace]
---
# Welcome Note

This is a #tju note and #ops/cluster.
\`\`\`bash
# this is a comment in code, not a tag #fake_tag
\`\`\`
Hex color #ffffff should be ignored.
`;
    const parsed = MarkdownParser.parseNote('test.md', text, { mtime: 1000, size: 200 });
    expect(parsed.metadata.tags).toContain('agi');
    expect(parsed.metadata.tags).toContain('mcp/workspace');
    expect(parsed.metadata.tags).toContain('tju');
    expect(parsed.metadata.tags).toContain('ops/cluster');
    expect(parsed.metadata.tags).not.toContain('fake_tag');
  });

  it('extracts task list items with completion status and line numbers', () => {
    const text = `
# Tasks
- [ ] Task 1: Initialize MCP
- [x] Task 2: Write Parser
- [ ] Task 3: Build Graph
`;
    const tasks = MarkdownParser.extractTasks('tasks.md', text);
    expect(tasks).toHaveLength(3);
    expect(tasks[0].completed).toBe(false);
    expect(tasks[0].text).toBe('Task 1: Initialize MCP');
    expect(tasks[1].completed).toBe(true);
  });
});

describe('VaultManager Integration', () => {
  let tmpVault: string;
  let vault: VaultManager;

  beforeEach(async () => {
    tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-test-'));
    vault = new VaultManager({ vaultPath: tmpVault });

    // Create seed notes
    await vault.writeNote(
      'index.md',
      'Welcome to [[Projects/AGI]]. See [[Resources/Models]]. #root',
      { title: 'Home Index', tags: ['index'] }
    );
    await vault.writeNote(
      'Projects/AGI.md',
      'AGI Project note linked to [[Resources/Models]] and [[index]].\n\n- [ ] Ship MCP',
      { tags: ['project', 'agi'] }
    );
    await vault.writeNote(
      'Resources/Models.md',
      'LLM Models and Specs. Mentioning [[NonExistentNote]].',
      { tags: ['resource'] }
    );
    await vault.writeNote('Orphan.md', 'I am alone.', { tags: ['lonely'] });
  });

  afterEach(async () => {
    await fs.rm(tmpVault, { recursive: true, force: true });
  });

  it('reads and indexes notes with backlinks', async () => {
    const note = await vault.getNote('Resources/Models.md');
    expect(note.metadata.title).toBe('Models');
    expect(note.metadata.backlinks).toContain('index.md');
    expect(note.metadata.backlinks).toContain('Projects/AGI.md');
  });

  it('finds notes by title alias or wikilink target', async () => {
    const note = await vault.getNote('Home Index');
    expect(note.path).toBe('index.md');
  });

  it('rejects a stale hash-bound write after an external sync change', async () => {
    const note = await vault.getNote('index.md');
    const expectedHash = crypto.createHash('sha256').update(note.rawContent).digest('hex');
    expect(note.sourceSha256).toBe(expectedHash);

    const syncedContent = '# Synced elsewhere\n';
    await fs.writeFile(path.join(tmpVault, 'index.md'), syncedContent, 'utf8');

    await expect(
      vault.writeNote('index.md', 'stale local edit', undefined, {
        overwrite: true,
        expectedSha256: expectedHash,
      }),
    ).rejects.toThrow(/hash/i);
    expect(await fs.readFile(path.join(tmpVault, 'index.md'), 'utf8')).toBe(syncedContent);
  });

  it('creates folders and lists folder hierarchies', async () => {
    await vault.createFolder('vault/tju/ml');
    await vault.writeNote('vault/tju/ml/lecture1.md', '# ML 101');

    const folders = await vault.listFolders();
    expect(folders.some((f) => f.path === 'vault/tju/ml')).toBe(true);
    expect(folders.find((f) => f.path === 'vault/tju/ml')?.notesCount).toBe(1);
  });

  it('generates recursive vault directory tree', async () => {
    const tree = await vault.getVaultTree();
    expect(tree.type).toBe('folder');
    expect(tree.children?.some((c) => c.name === 'Projects')).toBe(true);
    expect(tree.children?.some((c) => c.name === 'index.md')).toBe(true);
  });

  it('patches note with section replacement', async () => {
    await vault.writeNote('patch-test.md', '# Title\n\n## Tasks\n- [ ] Old Task\n\n## Notes\nSome info');
    await vault.patchNote('patch-test.md', {
      replaceSection: {
        heading: '## Tasks',
        content: '## Tasks\n- [x] Done Task',
      },
    });

    const updated = await vault.getNote('patch-test.md');
    expect(updated.body).toContain('- [x] Done Task');
    expect(updated.body).not.toContain('- [ ] Old Task');
    expect(updated.body).toContain('## Notes');
  });

  it('enforces path traversal boundaries', async () => {
    expect(() => vault.resolveSafePath('../../etc/passwd')).toThrow(/Security Violation/);
  });

  it('does not expose sibling folders through an allowed-subpath root tree', async () => {
    await fs.mkdir(path.join(tmpVault, 'public'), { recursive: true });
    await fs.mkdir(path.join(tmpVault, 'private'), { recursive: true });
    await fs.writeFile(path.join(tmpVault, 'public', 'visible.md'), 'visible');
    await fs.writeFile(path.join(tmpVault, 'private', 'hidden.md'), 'hidden');

    const restricted = new VaultManager({ vaultPath: tmpVault, allowedSubpaths: ['public'] });
    const tree = await restricted.getVaultTree();
    const names = tree.children?.map((child) => child.name) ?? [];

    expect(names).toContain('public');
    expect(names).not.toContain('private');
  });

  it('rejects symlinks that escape the vault', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.md'), 'outside secret');
      await fs.mkdir(path.join(tmpVault, 'public'), { recursive: true });
      await fs.symlink(outside, path.join(tmpVault, 'public', 'escape'));

      const restricted = new VaultManager({ vaultPath: tmpVault, allowedSubpaths: ['public'] });
      await expect(restricted.getNote('public/escape/secret.md')).rejects.toThrow(
        /symbolic link/i
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses to delete the vault root', async () => {
    await expect(vault.deleteItem('', true)).rejects.toThrow(/vault root/i);
    await expect(fs.stat(tmpVault)).resolves.toBeDefined();
  });

  it('analyzes workspace graph, orphans, and dangling links', async () => {
    const graph = await vault.getWorkspaceGraph();
    expect(graph.nodes.length).toBe(4);
    expect(graph.orphans).toContain('Orphan.md');
    expect(graph.danglingLinks.some((d) => d.targetTitle === 'NonExistentNote')).toBe(true);
  });

  it('searches notes by query and tags', async () => {
    const searchRes = await vault.searchNotes({ query: 'LLM', tags: ['resource'] });
    expect(searchRes.length).toBe(1);
    expect(searchRes[0].path).toBe('Resources/Models.md');
  });

  it('gathers all tasks across vault', async () => {
    const tasks = await vault.getTasks({ completed: false });
    expect(tasks.length).toBe(1);
    expect(tasks[0].text).toBe('Ship MCP');
  });
});
