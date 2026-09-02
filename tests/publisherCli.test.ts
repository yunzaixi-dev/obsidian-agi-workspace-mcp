import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPublisherCli } from '../src/publisherCli.js';
import { XPublicationQueue, type XurlExecutor } from '../src/xPublishing.js';

describe('local X publisher CLI', () => {
  let root: string;
  let requestId: string;
  let sourceSha256: string;

  it('prints help without requiring vault configuration', async () => {
    const output: string[] = [];
    const code = await runPublisherCli(['--help'], {
      env: {},
      stdout: (line) => output.push(line),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(output.join('\n')).toContain('obsidian-x-publisher');
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'x-publisher-cli-'));
    await fs.mkdir(path.join(root, 'docs/blogs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs/blogs/post.md'), '# Hello\n\nArticle body', 'utf8');
    const queue = new XPublicationQueue({
      vaultPath: root,
      allowedSubpaths: ['docs/blogs'],
      queuePath: 'docs/blogs/.x-publish',
    });
    const result = await queue.requestArticle('docs/blogs/post.md', '@yunzaixi');
    requestId = result.request.requestId;
    sourceSha256 = result.request.sourceSha256;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not invoke xurl when --yes is absent', async () => {
    const calls: string[][] = [];
    const execute: XurlExecutor = async (args) => {
      calls.push(args);
      return {};
    };
    const stderr: string[] = [];

    const exitCode = await runPublisherCli(
      ['draft', requestId, '--expected-sha', sourceSha256],
      {
        env: {
          OBSIDIAN_VAULT_PATH: root,
          OBSIDIAN_ALLOWED_SUBPATHS: 'docs/blogs',
          X_PUBLISH_QUEUE_PATH: 'docs/blogs/.x-publish',
        },
        execute,
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
      },
    );

    expect(exitCode).toBe(2);
    expect(calls).toHaveLength(0);
    expect(stderr.join('\n')).toMatch(/--yes/);
  });

  it('creates a draft with explicit hash-bound confirmation', async () => {
    const calls: string[][] = [];
    const output: string[] = [];
    const execute: XurlExecutor = async (args) => {
      calls.push(args);
      if (args.includes('/2/users/me')) return { data: { username: 'yunzaixi' } };
      return { data: { id: '123' } };
    };

    const exitCode = await runPublisherCli(
      ['draft', requestId, '--expected-sha', sourceSha256, '--app', 'blog', '--yes'],
      {
        env: {
          OBSIDIAN_VAULT_PATH: root,
          OBSIDIAN_ALLOWED_SUBPATHS: 'docs/blogs',
          X_PUBLISH_QUEUE_PATH: 'docs/blogs/.x-publish',
        },
        execute,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/2/users/me');
    expect(calls[1]).toContain('/2/articles/draft');
    expect(JSON.parse(output.join('\n'))).toMatchObject({ status: 'draft-created', articleId: '123' });
  });
});
