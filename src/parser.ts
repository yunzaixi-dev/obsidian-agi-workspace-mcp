import { NoteContent, NoteMetadata, TaskItem } from './types.js';
import crypto from 'node:crypto';
import matter from 'gray-matter';

export class MarkdownParser {
  /**
   * Extracts wikilinks from markdown content.
   * Matches [[Target Note]] and [[Target Note|Display Text]] and [[Target Note#Heading]]
   */
  public static extractWikilinks(text: string): string[] {
    const wikilinkRegex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
    const links = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = wikilinkRegex.exec(text)) !== null) {
      const link = match[1].trim();
      if (link) {
        links.add(link);
      }
    }

    return Array.from(links);
  }

  /**
   * Extracts tags from markdown body and frontmatter.
   * Matches #tag, #nested/tag, but avoids hex colors (#fff) and code blocks.
   */
  public static extractTags(body: string, frontmatterTags?: any): string[] {
    const tags = new Set<string>();

    if (Array.isArray(frontmatterTags)) {
      for (const t of frontmatterTags) {
        if (typeof t === 'string') {
          tags.add(t.replace(/^#/, '').trim());
        }
      }
    } else if (typeof frontmatterTags === 'string') {
      frontmatterTags
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#/, '').trim())
        .filter(Boolean)
        .forEach((t) => tags.add(t));
    }

    // Strip code blocks and inline code to prevent false tag matching
    const cleanBody = body
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '');

    const tagRegex = /(?:^|\s)#([a-zA-Z0-9_\-\u4e00-\u9fa5]+(?:\/[a-zA-Z0-9_\-\u4e00-\u9fa5]+)*)/g;
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(cleanBody)) !== null) {
      const tag = match[1].trim();
      if (tag && !/^[0-9a-fA-F]{3,6}$/.test(tag)) {
        tags.add(tag);
      }
    }

    return Array.from(tags);
  }

  /**
   * Parse a note's raw text into frontmatter, body, wikilinks, tags, and stats.
   */
  public static parseNote(
    relPath: string,
    rawText: string,
    stats: { mtime: number; size: number }
  ): NoteContent {
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(rawText);
    } catch {
      parsed = {
        data: {},
        content: rawText,
      } as any;
    }

    const frontmatter = parsed.data || {};
    const body = parsed.content || '';
    const title =
      frontmatter.title ||
      relPath.replace(/\.md$/i, '').split('/').pop() ||
      'Untitled';

    const wikilinks = this.extractWikilinks(rawText);
    const tags = this.extractTags(body, frontmatter.tags || frontmatter.tag);

    const metadata: NoteMetadata = {
      path: relPath,
      title,
      frontmatter,
      tags,
      wikilinks,
      mtime: stats.mtime,
      size: stats.size,
    };

    return {
      path: relPath,
      rawContent: rawText,
      sourceSha256: crypto.createHash('sha256').update(rawText).digest('hex'),
      frontmatter,
      body,
      metadata,
    };
  }

  /**
   * Extract markdown task items (- [ ] / - [x] / etc.) with line numbers.
   * Matches lines starting with - [ ] or anywhere in line if preceded by - [ ]
   */
  public static extractTasks(relPath: string, rawText: string): TaskItem[] {
    const lines = rawText.split('\n');
    const tasks: TaskItem[] = [];
    const taskRegex = /[-*+]\s+\[([ xX\/\-])\]\s+(.*)$/;

    lines.forEach((line, index) => {
      const match = taskRegex.exec(line);
      if (match) {
        const mark = match[1].trim().toLowerCase();
        const text = match[2].trim();
        tasks.push({
          path: relPath,
          line: index + 1,
          completed: mark === 'x',
          text,
          statusTag: `[${match[1]}]`,
        });
      }
    });

    return tasks;
  }

  /**
   * Render frontmatter and body back to markdown.
   */
  public static stringifyNote(body: string, frontmatter?: Record<string, any>): string {
    if (!frontmatter || Object.keys(frontmatter).length === 0) {
      return body;
    }
    return matter.stringify(body, frontmatter);
  }
}
