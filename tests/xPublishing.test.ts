import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LocalXPublisher,
  XPublicationQueue,
  renderXArticlePreview,
  type XurlExecutor,
} from '../src/xPublishing.js';

const TARGET = '@yunzaixi';

describe('X article preview', () => {
  it('renders the verified Markdown atomic-entity payload', () => {
    const preview = renderXArticlePreview('# 标题\n\n正文 **加粗**');

    expect(preview.title).toBe('标题');
    expect(preview.bodyChars).toBe(9);
    expect(preview.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.payload.content_state.blocks[0].type).toBe('atomic');
    expect(preview.payload.content_state.entities[0].value.data.markdown).toBe('正文 **加粗**');
  });

  it('rejects content beyond the verified article limit', () => {
    expect(() => renderXArticlePreview(`# 标题\n\n${'字'.repeat(10_001)}`)).toThrow(/10,000/);
  });
});

describe('sync-safe X publication queue', () => {
  let root: string;
  let queue: XPublicationQueue;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'x-publish-'));
    await fs.mkdir(path.join(root, 'docs/blogs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs/blogs/post.md'), '# Hello\n\nArticle body', 'utf8');
    queue = new XPublicationQueue({
      vaultPath: root,
      allowedSubpaths: ['docs/blogs'],
      queuePath: 'docs/blogs/.x-publish',
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('deduplicates requests for the same account, path, type, and source hash', async () => {
    const first = await queue.requestArticle('docs/blogs/post.md', TARGET);
    const second = await queue.requestArticle('docs/blogs/post.md', TARGET);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
    expect(first.request).not.toHaveProperty('token');
    expect(first.request).not.toHaveProperty('clientSecret');
  });

  it('creates a new request after source content changes', async () => {
    const first = await queue.requestArticle('docs/blogs/post.md', TARGET);
    await fs.writeFile(path.join(root, 'docs/blogs/post.md'), '# Hello\n\nChanged body', 'utf8');
    const second = await queue.requestArticle('docs/blogs/post.md', TARGET);

    expect(second.request.requestId).not.toBe(first.request.requestId);
  });

  it('reports requested and draft-created states from sync-safe receipts', async () => {
    const { request } = await queue.requestArticle('docs/blogs/post.md', TARGET);
    expect((await queue.getStatus(request.requestId)).status).toBe('requested');

    await queue.writeReceipt(request.requestId, {
      status: 'draft-created',
      articleId: '123',
      sourceSha256: request.sourceSha256,
    });
    expect(await queue.getStatus(request.requestId)).toMatchObject({
      status: 'draft-created',
      articleId: '123',
    });
  });

  it('requires explicit hash-bound confirmation before any remote draft write', async () => {
    const { request } = await queue.requestArticle('docs/blogs/post.md', TARGET);
    const calls: string[][] = [];
    const execute: XurlExecutor = async (args) => {
      calls.push(args);
      return { data: { id: '123' } };
    };
    const publisher = new LocalXPublisher(queue, execute);

    await expect(
      publisher.createDraft(request.requestId, { yes: false, expectedSha256: request.sourceSha256 }),
    ).rejects.toThrow(/--yes/);
    await expect(
      publisher.createDraft(request.requestId, { yes: true, expectedSha256: '0'.repeat(64) }),
    ).rejects.toThrow(/hash/i);
    expect(calls).toHaveLength(0);
  });

  it('rejects a publisher authenticated as a different X account', async () => {
    const { request } = await queue.requestArticle('docs/blogs/post.md', TARGET);
    const calls: string[][] = [];
    const execute: XurlExecutor = async (args) => {
      calls.push(args);
      return { data: { username: 'someone_else' } };
    };
    const publisher = new LocalXPublisher(queue, execute);

    await expect(
      publisher.createDraft(request.requestId, {
        yes: true,
        expectedSha256: request.sourceSha256,
      }),
    ).rejects.toThrow(/account/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/2/users/me');
  });

  it('creates then publishes an Article through official xurl endpoints', async () => {
    const { request } = await queue.requestArticle('docs/blogs/post.md', TARGET);
    const calls: string[][] = [];
    const execute: XurlExecutor = async (args) => {
      calls.push(args);
      if (args.includes('/2/users/me')) return { data: { username: 'yunzaixi' } };
      if (args.includes('/2/articles/draft')) return { data: { id: '123' } };
      return { data: { post_id: '456' } };
    };
    const publisher = new LocalXPublisher(queue, execute);

    await publisher.createDraft(request.requestId, {
      yes: true,
      expectedSha256: request.sourceSha256,
      app: 'blog',
    });
    await publisher.publishDraft(request.requestId, {
      yes: true,
      expectedSha256: request.sourceSha256,
      app: 'blog',
    });

    expect(calls.map((args) => args.find((arg) => arg.startsWith('/2/')))).toEqual([
      '/2/users/me',
      '/2/articles/draft',
      '/2/users/me',
      '/2/articles/123/publish',
    ]);
    expect(calls[0].slice(0, 2)).toEqual(['--app', 'blog']);
    expect(await queue.getStatus(request.requestId)).toMatchObject({
      status: 'published',
      articleId: '123',
      postId: '456',
    });
  });
});
