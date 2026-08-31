import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import {
  VaultConfig,
  NoteContent,
  NoteMetadata,
  SearchOptions,
  SearchResult,
  WorkspaceGraph,
  GraphNode,
  GraphEdge,
  TaskItem,
} from './types.js';
import { MarkdownParser } from './parser.js';

export class VaultManager {
  private vaultPath: string;
  private allowedSubpaths?: string[];
  private readOnly: boolean;

  // In-memory index cache
  private notesCache: Map<string, NoteContent> = new Map();
  private titleToPath: Map<string, string> = new Map();
  private backlinksMap: Map<string, Set<string>> = new Map();
  private isIndexed: boolean = false;

  constructor(config: VaultConfig) {
    this.vaultPath = path.resolve(config.vaultPath);
    this.allowedSubpaths = config.allowedSubpaths?.map((p) =>
      path.normalize(p).replace(/^\/+|\/+$/g, '')
    );
    this.readOnly = config.readOnly ?? false;
  }

  public getVaultPath(): string {
    return this.vaultPath;
  }

  /**
   * Ensure a requested relative path resolves safely inside the vault and permitted subpaths.
   */
  public resolveSafePath(relPath: string): { fullPath: string; normalizedRelPath: string } {
    let cleanRel = path.normalize(relPath).replace(/^[\\\/]+/, '');
    if (!cleanRel.endsWith('.md') && !path.extname(cleanRel)) {
      cleanRel += '.md';
    }

    const fullPath = path.resolve(this.vaultPath, cleanRel);

    // Security check: Path traversal prevention
    const relativeToRoot = path.relative(this.vaultPath, fullPath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Security Violation: Path traversal outside vault boundary: ${relPath}`);
    }

    // Check allowed subpaths if configured
    if (this.allowedSubpaths && this.allowedSubpaths.length > 0) {
      const isAllowed = this.allowedSubpaths.some(
        (sub) => relativeToRoot === sub || relativeToRoot.startsWith(sub + path.sep)
      );
      if (!isAllowed) {
        throw new Error(
          `Access Denied: Path '${relativeToRoot}' is outside permitted subpaths: [${this.allowedSubpaths.join(', ')}]`
        );
      }
    }

    return { fullPath, normalizedRelPath: relativeToRoot };
  }

  /**
   * Scan and index all markdown files in vault.
   */
  public async indexVault(): Promise<void> {
    const pattern = '**/*.md';
    const ignorePatterns = [
      '**/.obsidian/**',
      '**/.git/**',
      '**/node_modules/**',
      '**/.trash/**',
      '**/.trash*/**',
    ];

    const entries = await fg(pattern, {
      cwd: this.vaultPath,
      ignore: ignorePatterns,
      onlyFiles: true,
      stats: true,
    });

    this.notesCache.clear();
    this.titleToPath.clear();
    this.backlinksMap.clear();

    for (const entry of entries) {
      const relPath = path.normalize(entry.path);

      // Check subpath filter
      if (this.allowedSubpaths && this.allowedSubpaths.length > 0) {
        const isAllowed = this.allowedSubpaths.some(
          (sub) => relPath === sub || relPath.startsWith(sub + path.sep)
        );
        if (!isAllowed) continue;
      }

      const fullPath = path.join(this.vaultPath, relPath);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const mtime = entry.stats ? entry.stats.mtimeMs : Date.now();
        const size = entry.stats ? entry.stats.size : Buffer.byteLength(content);

        const parsed = MarkdownParser.parseNote(relPath, content, { mtime, size });
        this.notesCache.set(relPath, parsed);

        // Map titles and filenames
        const baseName = path.basename(relPath, '.md');
        this.titleToPath.set(baseName.toLowerCase(), relPath);
        if (parsed.metadata.title) {
          this.titleToPath.set(parsed.metadata.title.toLowerCase(), relPath);
        }
      } catch (err) {
        // Skip unreadable files
      }
    }

    // Build backlinks index
    for (const [sourcePath, note] of this.notesCache.entries()) {
      for (const targetLink of note.metadata.wikilinks) {
        const resolvedTarget = this.resolveLinkTarget(targetLink);
        if (resolvedTarget) {
          if (!this.backlinksMap.has(resolvedTarget)) {
            this.backlinksMap.set(resolvedTarget, new Set());
          }
          this.backlinksMap.get(resolvedTarget)!.add(sourcePath);
        }
      }
    }

    // Attach backlinks to metadata
    for (const [notePath, note] of this.notesCache.entries()) {
      const backlinks = this.backlinksMap.get(notePath);
      note.metadata.backlinks = backlinks ? Array.from(backlinks) : [];
    }

    this.isIndexed = true;
  }

  private resolveLinkTarget(linkText: string): string | null {
    // If it is a direct path match
    let normalized = path.normalize(linkText).replace(/^[\\\/]+/, '');
    if (!normalized.endsWith('.md')) normalized += '.md';

    if (this.notesCache.has(normalized)) {
      return normalized;
    }

    // Match by title / basename
    const rawTarget = linkText.replace(/\.md$/i, '').toLowerCase();
    const mapped = this.titleToPath.get(rawTarget);
    if (mapped && this.notesCache.has(mapped)) {
      return mapped;
    }

    return null;
  }

  /**
   * Get a single note by relative path or title.
   */
  public async getNote(relPathOrTitle: string): Promise<NoteContent> {
    if (!this.isIndexed) await this.indexVault();

    let targetPath: string | null = null;
    try {
      const { normalizedRelPath } = this.resolveSafePath(relPathOrTitle);
      if (this.notesCache.has(normalizedRelPath)) {
        targetPath = normalizedRelPath;
      }
    } catch {
      // not a direct path
    }

    if (!targetPath) {
      targetPath = this.resolveLinkTarget(relPathOrTitle);
    }

    if (!targetPath) {
      const { normalizedRelPath } = this.resolveSafePath(relPathOrTitle);
      targetPath = normalizedRelPath;
    }

    const { fullPath, normalizedRelPath } = this.resolveSafePath(targetPath);
    try {
      const stat = await fs.stat(fullPath);
      const rawText = await fs.readFile(fullPath, 'utf-8');
      const parsed = MarkdownParser.parseNote(normalizedRelPath, rawText, {
        mtime: stat.mtimeMs,
        size: stat.size,
      });

      const backlinks = this.backlinksMap.get(normalizedRelPath);
      parsed.metadata.backlinks = backlinks ? Array.from(backlinks) : [];

      this.notesCache.set(normalizedRelPath, parsed);
      return parsed;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(`Note not found: '${relPathOrTitle}' (resolved as '${normalizedRelPath}')`);
      }
      throw err;
    }
  }

  /**
   * Create or overwrite a note.
   */
  public async writeNote(
    relPath: string,
    body: string,
    frontmatter?: Record<string, any>,
    options?: { overwrite?: boolean }
  ): Promise<NoteMetadata> {
    if (this.readOnly) {
      throw new Error('Vault is configured in read-only mode.');
    }

    const { fullPath, normalizedRelPath } = this.resolveSafePath(relPath);

    const exists = await fs
      .stat(fullPath)
      .then(() => true)
      .catch(() => false);

    if (exists && options?.overwrite === false) {
      throw new Error(`Note already exists at '${normalizedRelPath}' and overwrite is false.`);
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const fileContent = MarkdownParser.stringifyNote(body, frontmatter);
    await fs.writeFile(fullPath, fileContent, 'utf-8');

    // Update index
    const stat = await fs.stat(fullPath);
    const parsed = MarkdownParser.parseNote(normalizedRelPath, fileContent, {
      mtime: stat.mtimeMs,
      size: stat.size,
    });

    this.notesCache.set(normalizedRelPath, parsed);
    const baseName = path.basename(normalizedRelPath, '.md');
    this.titleToPath.set(baseName.toLowerCase(), normalizedRelPath);
    if (parsed.metadata.title) {
      this.titleToPath.set(parsed.metadata.title.toLowerCase(), normalizedRelPath);
    }

    return parsed.metadata;
  }

  /**
   * Append content to an existing note, or targeted patch under a heading.
   */
  public async patchNote(
    relPath: string,
    options: {
      append?: string;
      prepend?: string;
      replaceSection?: { heading: string; content: string };
      patchRegex?: { pattern: string; replacement: string; flags?: string };
      updateFrontmatter?: Record<string, any>;
    }
  ): Promise<NoteMetadata> {
    if (this.readOnly) {
      throw new Error('Vault is configured in read-only mode.');
    }

    const note = await this.getNote(relPath);
    let body = note.body;
    let frontmatter = { ...note.frontmatter, ...(options.updateFrontmatter || {}) };

    if (options.prepend) {
      body = `${options.prepend}\n\n${body}`;
    }

    if (options.append) {
      body = `${body.trimEnd()}\n\n${options.append}\n`;
    }

    if (options.replaceSection) {
      const cleanHeading = options.replaceSection.heading.replace(/^#+\s*/, '').trim();
      const escapedHeading = cleanHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const lines = body.split('\n');
      let startLine = -1;
      let endLine = lines.length;
      let matchedLevel = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
        if (headingMatch) {
          const level = headingMatch[1].length;
          const text = headingMatch[2].trim();
          if (startLine === -1) {
            if (text.toLowerCase() === cleanHeading.toLowerCase()) {
              startLine = i;
              matchedLevel = level;
            }
          } else {
            // Reached next heading of same or higher hierarchy level
            if (level <= matchedLevel) {
              endLine = i;
              break;
            }
          }
        }
      }

      if (startLine !== -1) {
        const replacementLines = options.replaceSection.content.trim().split('\n');
        lines.splice(startLine, endLine - startLine, ...replacementLines);
        body = lines.join('\n');
      } else {
        body = `${body.trimEnd()}\n\n${options.replaceSection.content.trim()}\n`;
      }
    }

    if (options.patchRegex) {
      const reg = new RegExp(options.patchRegex.pattern, options.patchRegex.flags || 'g');
      body = body.replace(reg, options.patchRegex.replacement);
    }

    return this.writeNote(note.path, body, frontmatter, { overwrite: true });
  }

  /**
   * Search notes by keyword, tags, frontmatter, or folder path.
   */
  public async searchNotes(options: SearchOptions): Promise<SearchResult[]> {
    if (!this.isIndexed) await this.indexVault();

    const results: SearchResult[] = [];
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const query = options.query?.toLowerCase();

    for (const [notePath, note] of this.notesCache.entries()) {
      if (options.folder && !notePath.startsWith(options.folder)) {
        continue;
      }

      if (options.tags && options.tags.length > 0) {
        const hasAllTags = options.tags.every((t) =>
          note.metadata.tags.map((x) => x.toLowerCase()).includes(t.toLowerCase().replace(/^#/, ''))
        );
        if (!hasAllTags) continue;
      }

      if (options.frontmatterFilter) {
        let match = true;
        for (const [k, v] of Object.entries(options.frontmatterFilter)) {
          if (note.frontmatter[k] !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }

      if (query) {
        const titleMatch = note.metadata.title.toLowerCase().includes(query);
        const pathMatch = notePath.toLowerCase().includes(query);
        const bodyIndex = note.body.toLowerCase().indexOf(query);

        if (titleMatch || pathMatch || bodyIndex !== -1) {
          let snippet = '';
          if (bodyIndex !== -1) {
            const start = Math.max(0, bodyIndex - 60);
            const end = Math.min(note.body.length, bodyIndex + query.length + 60);
            snippet = (start > 0 ? '...' : '') + note.body.slice(start, end).replace(/\n/g, ' ') + (end < note.body.length ? '...' : '');
          }

          results.push({
            path: notePath,
            title: note.metadata.title,
            matchedContent: snippet || (titleMatch ? `Matched title: ${note.metadata.title}` : `Matched path: ${notePath}`),
            score: titleMatch ? 100 : pathMatch ? 80 : 50,
            tags: note.metadata.tags,
            frontmatter: note.frontmatter,
          });
        }
      } else {
        results.push({
          path: notePath,
          title: note.metadata.title,
          tags: note.metadata.tags,
          frontmatter: note.frontmatter,
        });
      }
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    return results.slice(offset, offset + limit);
  }

  /**
   * Extract all task checklists (- [ ] / - [x]) across matching notes.
   */
  public async getTasks(options?: { completed?: boolean; folder?: string; tag?: string }): Promise<TaskItem[]> {
    if (!this.isIndexed) await this.indexVault();

    const allTasks: TaskItem[] = [];
    for (const [notePath, note] of this.notesCache.entries()) {
      if (options?.folder && !notePath.startsWith(options.folder)) continue;
      if (options?.tag && !note.metadata.tags.includes(options.tag.replace(/^#/, ''))) continue;

      const tasks = MarkdownParser.extractTasks(notePath, note.rawContent);
      for (const t of tasks) {
        if (options?.completed !== undefined && t.completed !== options.completed) {
          continue;
        }
        allTasks.push(t);
      }
    }

    return allTasks;
  }

  /**
   * Generate graph analysis (Nodes, Edges, Orphan Notes, Dangling Links).
   */
  public async getWorkspaceGraph(): Promise<WorkspaceGraph> {
    if (!this.isIndexed) await this.indexVault();

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const danglingLinks: { source: string; targetTitle: string }[] = [];
    const connectedNodeIds = new Set<string>();

    for (const [notePath, note] of this.notesCache.entries()) {
      const outgoingTargets: string[] = [];

      for (const wikilink of note.metadata.wikilinks) {
        const resolved = this.resolveLinkTarget(wikilink);
        if (resolved) {
          outgoingTargets.push(resolved);
          edges.push({
            source: notePath,
            target: resolved,
            type: 'wikilink',
          });
          connectedNodeIds.add(notePath);
          connectedNodeIds.add(resolved);
        } else {
          danglingLinks.push({
            source: notePath,
            targetTitle: wikilink,
          });
        }
      }

      nodes.push({
        id: notePath,
        title: note.metadata.title,
        tags: note.metadata.tags,
        links: outgoingTargets,
      });
    }

    const orphans = nodes
      .filter((n) => !connectedNodeIds.has(n.id))
      .map((n) => n.id);

    return {
      nodes,
      edges,
      orphans,
      danglingLinks,
    };
  }

  /**
   * Delete a note (move to .trash or remove).
   */
  public async deleteNote(relPath: string, permanent: boolean = false): Promise<boolean> {
    if (this.readOnly) {
      throw new Error('Vault is configured in read-only mode.');
    }

    const { fullPath, normalizedRelPath } = this.resolveSafePath(relPath);

    if (permanent) {
      await fs.unlink(fullPath);
    } else {
      const trashDir = path.join(this.vaultPath, '.trash');
      await fs.mkdir(trashDir, { recursive: true });
      const trashDest = path.join(trashDir, path.basename(normalizedRelPath));
      await fs.rename(fullPath, trashDest);
    }

    this.notesCache.delete(normalizedRelPath);
    return true;
  }
}
