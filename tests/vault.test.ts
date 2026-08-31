import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
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
      'AGI Project note linked to [[Resources/Models]] and [[index]]. - [ ] Ship MCP',
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
