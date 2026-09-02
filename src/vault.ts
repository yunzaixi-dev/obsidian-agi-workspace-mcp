import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
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
  VaultTreeNode,
  FolderNode,
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

  private isAllowedPath(relPath: string, includeAncestors: boolean = false): boolean {
    if (!this.allowedSubpaths || this.allowedSubpaths.length === 0) return true;
    if (relPath === '') return includeAncestors;

    return this.allowedSubpaths.some(
      (sub) =>
        relPath === sub ||
        relPath.startsWith(sub + path.sep) ||
        (includeAncestors && sub.startsWith(relPath + path.sep))
    );
  }

  private assertNoSymbolicLinks(fullPath: string, originalPath: string): void {
    const relative = path.relative(this.vaultPath, fullPath);
    if (!relative) return;

    let current = this.vaultPath;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (fsSync.lstatSync(current).isSymbolicLink()) {
          throw new Error(
            `Security Violation: symbolic link traversal is not allowed: ${originalPath}`
          );
        }
      } catch (err: any) {
        if (err?.code === 'ENOENT') break;
        throw err;
      }
    }
  }

  /**
   * Ensure a requested relative path resolves safely inside the vault and permitted subpaths.
   */
  public resolveSafePath(
    relPath: string,
    options?: { isDirectory?: boolean; allowNonMd?: boolean; allowAllowedAncestor?: boolean }
  ): { fullPath: string; normalizedRelPath: string } {
    let cleanRel = path.normalize(relPath || '.').replace(/^[\\\/]+/, '');
    if (cleanRel === '.' || cleanRel === '') {
      cleanRel = '';
    }

    if (!options?.isDirectory && !options?.allowNonMd && cleanRel !== '') {
      if (!cleanRel.endsWith('.md') && !path.extname(cleanRel)) {
        cleanRel += '.md';
      }
    }

    const fullPath = path.resolve(this.vaultPath, cleanRel);

    // Security check: Path traversal prevention
    const relativeToRoot = path.relative(this.vaultPath, fullPath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Security Violation: Path traversal outside vault boundary: ${relPath}`);
    }

    // Check allowed subpaths if configured
    if (!this.isAllowedPath(relativeToRoot, options?.allowAllowedAncestor === true)) {
      throw new Error(
        `Access Denied: Path '${relativeToRoot}' is outside permitted subpaths: [${this.allowedSubpaths!.join(', ')}]`
      );
    }

    this.assertNoSymbolicLinks(fullPath, relPath);

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
    let normalized = path.normalize(linkText).replace(/^[\\\/]+/, '');
    if (!normalized.endsWith('.md')) normalized += '.md';

    if (this.notesCache.has(normalized)) {
      return normalized;
    }

    const rawTarget = linkText.replace(/\.md$/i, '').toLowerCase();
    const mapped = this.titleToPath.get(rawTarget);
    if (mapped && this.notesCache.has(mapped)) {
      return mapped;
    }

    return null;
  }

  /**
   * Create a new folder or ensure folder hierarchy exists.
   */
  public async createFolder(folderPath: string): Promise<{ fullPath: string; relativePath: string }> {
    if (this.readOnly) {
      throw new Error('Vault is configured in read-only mode.');
    }

    const { fullPath, normalizedRelPath } = this.resolveSafePath(folderPath, { isDirectory: true });
    await fs.mkdir(fullPath, { recursive: true });
    return { fullPath, relativePath: normalizedRelPath };
  }

  /**
   * List folders in the vault with note counts and subfolder hierarchy.
   */
  public async listFolders(parentFolder?: string): Promise<FolderNode[]> {
    if (!this.isIndexed) await this.indexVault();

    const folderMap = new Map<string, { subfolders: Set<string>; notesCount: number }>();
    const rootRel = parentFolder ? path.normalize(parentFolder).replace(/^[\\\/]+|\/+$/g, '') : '';

    // Register root/target folder
    folderMap.set(rootRel, { subfolders: new Set(), notesCount: 0 });

    for (const [notePath] of this.notesCache.entries()) {
      const dir = path.dirname(notePath);
      const normalizedDir = dir === '.' ? '' : dir;

      if (rootRel && !normalizedDir.startsWith(rootRel)) {
        continue;
      }

      // Populate hierarchy
      let current = normalizedDir;
      while (true) {
        if (!folderMap.has(current)) {
          folderMap.set(current, { subfolders: new Set(), notesCount: 0 });
        }
        if (current === normalizedDir) {
          folderMap.get(current)!.notesCount += 1;
        }

        if (!current || current === rootRel) break;
        const parent = path.dirname(current);
        const normParent = parent === '.' ? '' : parent;
        if (!folderMap.has(normParent)) {
          folderMap.set(normParent, { subfolders: new Set(), notesCount: 0 });
        }
        folderMap.get(normParent)!.subfolders.add(current);
        current = normParent;
      }
    }

    const result: FolderNode[] = [];
    for (const [fPath, data] of folderMap.entries()) {
      result.push({
        path: fPath || '/',
        name: fPath ? path.basename(fPath) : 'root',
        subfolders: Array.from(data.subfolders),
        notesCount: data.notesCount,
      });
    }

    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Get hierarchical file and folder directory tree of the vault.
   */
  public async getVaultTree(subfolder?: string, maxDepth: number = 5): Promise<VaultTreeNode> {
    const { fullPath, normalizedRelPath } = this.resolveSafePath(subfolder || '', {
      isDirectory: true,
      allowAllowedAncestor: true,
    });

    const walk = async (currentFullPath: string, currentRelPath: string, depth: number): Promise<VaultTreeNode> => {
      const stat = await fs.stat(currentFullPath);
      const baseName = currentRelPath ? path.basename(currentRelPath) : 'vault';

      if (!stat.isDirectory()) {
        return {
          name: baseName,
          path: currentRelPath,
          type: baseName.endsWith('.md') ? 'note' : 'file',
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      }

      const node: VaultTreeNode = {
        name: baseName,
        path: currentRelPath || '/',
        type: 'folder',
        mtime: stat.mtimeMs,
        children: [],
      };

      if (depth >= maxDepth) return node;

      const entries = await fs.readdir(currentFullPath, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === '.obsidian' ||
          entry.name === '.git'
        ) {
          continue;
        }

        const childFull = path.join(currentFullPath, entry.name);
        const childRel = currentRelPath ? path.join(currentRelPath, entry.name) : entry.name;
        if (!this.isAllowedPath(childRel, true) || entry.isSymbolicLink()) {
          continue;
        }
        const childNode = await walk(childFull, childRel, depth + 1);
        node.children!.push(childNode);
      }

      node.children!.sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return a.name.localeCompare(b.name);
      });

      return node;
    };

    return walk(fullPath, normalizedRelPath, 1);
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
    options?: { overwrite?: boolean; expectedSha256?: string }
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

    if (options?.expectedSha256) {
      if (!/^[a-f0-9]{64}$/i.test(options.expectedSha256)) {
        throw new Error('expectedSha256 must be a 64-character hexadecimal SHA-256 digest.');
      }
      if (!exists) {
        throw new Error(`Content hash conflict: '${normalizedRelPath}' no longer exists.`);
      }
      const currentContent = await fs.readFile(fullPath, 'utf8');
      const currentSha256 = crypto.createHash('sha256').update(currentContent).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(currentSha256), Buffer.from(options.expectedSha256))) {
        throw new Error(
          `Content hash conflict for '${normalizedRelPath}': the note changed after it was read.`,
        );
      }
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const fileContent = MarkdownParser.stringifyNote(body, frontmatter);
    const tempPath = path.join(
      path.dirname(fullPath),
      `.${path.basename(fullPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let tempHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      tempHandle = await fs.open(tempPath, 'wx', 0o600);
      await tempHandle.writeFile(fileContent, 'utf8');
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = undefined;

      // Re-run the jail check immediately before the replacing rename.
      this.resolveSafePath(normalizedRelPath);
      await fs.rename(tempPath, fullPath);
    } finally {
      await tempHandle?.close().catch(() => undefined);
      await fs.unlink(tempPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }

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
      expectedSha256?: string;
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

    return this.writeNote(note.path, body, frontmatter, {
      overwrite: true,
      expectedSha256: options.expectedSha256,
    });
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
            snippet =
              (start > 0 ? '...' : '') +
              note.body.slice(start, end).replace(/\n/g, ' ') +
              (end < note.body.length ? '...' : '');
          }

          results.push({
            path: notePath,
            title: note.metadata.title,
            matchedContent:
              snippet ||
              (titleMatch ? `Matched title: ${note.metadata.title}` : `Matched path: ${notePath}`),
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
   * Delete a note or folder (moves to .trash or removes).
   */
  public async deleteItem(relPath: string, permanent: boolean = false): Promise<boolean> {
    if (this.readOnly) {
      throw new Error('Vault is configured in read-only mode.');
    }

    const { fullPath, normalizedRelPath } = this.resolveSafePath(relPath, { isDirectory: true, allowNonMd: true });

    if (!normalizedRelPath) {
      throw new Error('Refusing to delete the vault root.');
    }

    if (permanent) {
      await fs.rm(fullPath, { recursive: true, force: true });
    } else {
      const trashDir = path.join(this.vaultPath, '.trash');
      await fs.mkdir(trashDir, { recursive: true });
      const trashDest = path.join(trashDir, `${Date.now()}_${path.basename(normalizedRelPath)}`);
      await fs.rename(fullPath, trashDest);
    }

    this.notesCache.delete(normalizedRelPath);
    return true;
  }
}
