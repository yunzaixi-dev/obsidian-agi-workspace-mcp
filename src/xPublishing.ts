import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { VaultManager } from './vault.js';

const execFileAsync = promisify(execFile);
const ARTICLE_LIMIT = 10_000;
const REQUEST_ID_RE = /^[a-f0-9]{64}$/;
const X_ID_RE = /^[0-9]{1,19}$/;

export type PublicationStatus = 'requested' | 'draft-created' | 'published' | 'failed';

export interface XArticlePayload {
  title: string;
  content_state: {
    blocks: Array<{
      key: string;
      text: string;
      type: 'atomic';
      entity_ranges: Array<{ key: number; offset: number; length: number }>;
      inline_style_ranges: unknown[];
      data: Record<string, unknown>;
    }>;
    entities: Array<{
      key: number;
      value: {
        type: 'markdown';
        mutability: 'mutable';
        data: { markdown: string };
      };
    }>;
  };
}

export interface XArticlePreview {
  title: string;
  bodyChars: number;
  sourceSha256: string;
  payload: XArticlePayload;
}

export interface XPublicationRequest {
  schemaVersion: 1;
  requestId: string;
  idempotencyKey: string;
  type: 'article';
  targetAccount: string;
  sourcePath: string;
  sourceSha256: string;
  title: string;
  bodyChars: number;
  payload: XArticlePayload;
  createdAt: string;
}

export interface XPublicationReceipt {
  schemaVersion: 1;
  requestId: string;
  status: Exclude<PublicationStatus, 'requested'>;
  sourceSha256: string;
  articleId?: string;
  postId?: string;
  error?: string;
  updatedAt: string;
}

export interface XPublicationState {
  request: XPublicationRequest;
  status: PublicationStatus;
  articleId?: string;
  postId?: string;
  error?: string;
  updatedAt?: string;
}

export interface XPublicationQueueConfig {
  vaultPath: string;
  allowedSubpaths?: string[];
  queuePath: string;
}

export interface PublishConfirmation {
  yes: boolean;
  expectedSha256: string;
  app?: string;
}

export type XurlExecutor = (args: string[]) => Promise<Record<string, any>>;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeMarkdown(document: string): string {
  return document.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseMarkdown(document: string): { title: string; body: string } {
  const lines = normalizeMarkdown(document).split('\n');
  const titleIndex = lines.findIndex((line) => line.startsWith('# ') && line.slice(2).trim());
  if (titleIndex < 0) throw new Error('Markdown must contain a non-empty H1 title.');
  const title = lines[titleIndex].slice(2).trim();
  const body = lines.slice(titleIndex + 1).join('\n').trim();
  if (!body) throw new Error('Article body must not be empty.');
  return { title, body };
}

export function renderXArticlePreview(markdown: string): XArticlePreview {
  const normalized = normalizeMarkdown(markdown);
  const { title, body } = parseMarkdown(normalized);
  if (body.length > ARTICLE_LIMIT) {
    throw new Error(`Article body contains ${body.length} characters and exceeds the verified 10,000 character limit.`);
  }
  return {
    title,
    bodyChars: body.length,
    sourceSha256: sha256(normalized),
    payload: {
      title,
      content_state: {
        blocks: [
          {
            key: 'xblog0',
            text: ' ',
            type: 'atomic',
            entity_ranges: [{ key: 0, offset: 0, length: 1 }],
            inline_style_ranges: [],
            data: {},
          },
        ],
        entities: [
          {
            key: 0,
            value: {
              type: 'markdown',
              mutability: 'mutable',
              data: { markdown: body },
            },
          },
        ],
      },
    },
  };
}

function normalizeAccount(account: string): string {
  const bare = account.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(bare)) throw new Error('Target X account must be a valid handle.');
  return `@${bare}`;
}

function validateRequestId(requestId: string): void {
  if (!REQUEST_ID_RE.test(requestId)) throw new Error('Invalid publication request ID.');
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function writeJsonAtomic(filePath: string, value: unknown, exclusive: boolean): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    if (exclusive) {
      await fs.link(temporary, filePath);
    } else {
      await fs.rename(temporary, filePath);
    }
    return true;
  } catch (error: any) {
    if (exclusive && error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export class XPublicationQueue {
  private readonly vault: VaultManager;
  private readonly queueDirectory: string;

  constructor(config: XPublicationQueueConfig) {
    this.vault = new VaultManager({
      vaultPath: config.vaultPath,
      allowedSubpaths: config.allowedSubpaths,
    });
    if (!config.queuePath.trim()) throw new Error('X publication queue path must not be empty.');
    this.queueDirectory = this.vault.resolveSafePath(config.queuePath, {
      isDirectory: true,
      allowNonMd: true,
    }).fullPath;
  }

  async previewSource(sourcePath: string): Promise<XArticlePreview> {
    const { fullPath } = this.vault.resolveSafePath(sourcePath);
    return renderXArticlePreview(await fs.readFile(fullPath, 'utf8'));
  }

  async requestArticle(
    sourcePath: string,
    targetAccount: string,
  ): Promise<{ created: boolean; request: XPublicationRequest }> {
    const { normalizedRelPath: normalizedPath } = this.vault.resolveSafePath(sourcePath);
    const account = normalizeAccount(targetAccount);
    const preview = await this.previewSource(normalizedPath);
    const idempotencyKey = sha256(
      JSON.stringify([1, 'article', account, normalizedPath, preview.sourceSha256]),
    );
    const request: XPublicationRequest = {
      schemaVersion: 1,
      requestId: idempotencyKey,
      idempotencyKey,
      type: 'article',
      targetAccount: account,
      sourcePath: normalizedPath,
      sourceSha256: preview.sourceSha256,
      title: preview.title,
      bodyChars: preview.bodyChars,
      payload: preview.payload,
      createdAt: new Date().toISOString(),
    };
    const requestPath = this.requestPath(idempotencyKey);
    const created = await writeJsonAtomic(requestPath, request, true);
    return { created, request: created ? request : await readJson<XPublicationRequest>(requestPath) };
  }

  async getRequest(requestId: string): Promise<XPublicationRequest> {
    validateRequestId(requestId);
    return readJson<XPublicationRequest>(this.requestPath(requestId));
  }

  async getStatus(requestId: string): Promise<XPublicationState> {
    const request = await this.getRequest(requestId);
    try {
      const receipt = await readJson<XPublicationReceipt>(this.receiptPath(requestId));
      return {
        request,
        status: receipt.status,
        articleId: receipt.articleId,
        postId: receipt.postId,
        error: receipt.error,
        updatedAt: receipt.updatedAt,
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      return { request, status: 'requested' };
    }
  }

  async writeReceipt(
    requestId: string,
    receipt: Omit<XPublicationReceipt, 'schemaVersion' | 'requestId' | 'updatedAt'>,
  ): Promise<XPublicationReceipt> {
    const request = await this.getRequest(requestId);
    if (receipt.sourceSha256 !== request.sourceSha256) throw new Error('Receipt source hash does not match request.');
    if (receipt.articleId !== undefined && !X_ID_RE.test(receipt.articleId)) throw new Error('Invalid X Article ID.');
    if (receipt.postId !== undefined && !X_ID_RE.test(receipt.postId)) throw new Error('Invalid X Post ID.');
    const record: XPublicationReceipt = {
      schemaVersion: 1,
      requestId,
      ...receipt,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(this.receiptPath(requestId), record, false);
    return record;
  }

  async verifyCurrentSource(request: XPublicationRequest): Promise<void> {
    const current = await this.previewSource(request.sourcePath);
    if (current.sourceSha256 !== request.sourceSha256) {
      throw new Error('Source hash changed after the publication request was created. Create a new request.');
    }
  }

  private requestPath(requestId: string): string {
    validateRequestId(requestId);
    return path.join(this.queueDirectory, `${requestId}.request.json`);
  }

  private receiptPath(requestId: string): string {
    validateRequestId(requestId);
    return path.join(this.queueDirectory, `${requestId}.receipt.json`);
  }
}

export async function executeXurl(args: string[]): Promise<Record<string, any>> {
  const { stdout, stderr } = await execFileAsync('xurl', args, {
    encoding: 'utf8',
    maxBuffer: 1_048_576,
    env: process.env,
  });
  const output = stdout.trim();
  if (!output) {
    if (stderr.trim()) throw new Error(stderr.trim());
    return {};
  }
  return JSON.parse(output) as Record<string, any>;
}

function xurlArgs(method: string, endpoint: string, payload: unknown, app?: string): string[] {
  const args: string[] = [];
  if (app) args.push('--app', app);
  args.push('-X', method, endpoint);
  if (payload !== undefined) {
    args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(payload));
  }
  return args;
}

function responseId(response: Record<string, any>, key: 'id' | 'post_id', label: string): string {
  const value = String(response.data?.[key] ?? '');
  if (!X_ID_RE.test(value)) throw new Error(`xurl returned an invalid ${label}.`);
  return value;
}

export class LocalXPublisher {
  constructor(
    private readonly queue: XPublicationQueue,
    private readonly execute: XurlExecutor = executeXurl,
  ) {}

  async createDraft(requestId: string, confirmation: PublishConfirmation): Promise<XPublicationReceipt> {
    const request = await this.confirm(requestId, confirmation);
    const response = await this.execute(xurlArgs('POST', '/2/articles/draft', request.payload, confirmation.app));
    const articleId = responseId(response, 'id', 'Article ID');
    return this.queue.writeReceipt(requestId, {
      status: 'draft-created',
      sourceSha256: request.sourceSha256,
      articleId,
    });
  }

  async publishDraft(requestId: string, confirmation: PublishConfirmation): Promise<XPublicationReceipt> {
    const request = await this.confirm(requestId, confirmation);
    const state = await this.queue.getStatus(requestId);
    if (state.status !== 'draft-created' || !state.articleId) {
      throw new Error('Publication request does not have a draft-created receipt.');
    }
    const response = await this.execute(
      xurlArgs('POST', `/2/articles/${state.articleId}/publish`, undefined, confirmation.app),
    );
    const postId = responseId(response, 'post_id', 'Post ID');
    return this.queue.writeReceipt(requestId, {
      status: 'published',
      sourceSha256: request.sourceSha256,
      articleId: state.articleId,
      postId,
    });
  }

  private async confirm(requestId: string, confirmation: PublishConfirmation): Promise<XPublicationRequest> {
    if (!confirmation.yes) throw new Error('Remote X write requires explicit --yes confirmation.');
    const request = await this.queue.getRequest(requestId);
    if (confirmation.expectedSha256 !== request.sourceSha256) {
      throw new Error('Confirmation hash does not match the publication request source hash.');
    }
    await this.queue.verifyCurrentSource(request);

    const me = await this.execute(
      xurlArgs('GET', '/2/users/me', undefined, confirmation.app),
    );
    const authenticatedUsername = String(me.data?.username ?? '');
    let authenticatedAccount: string;
    try {
      authenticatedAccount = normalizeAccount(authenticatedUsername);
    } catch {
      throw new Error('Unable to verify the authenticated X account from /2/users/me.');
    }
    if (authenticatedAccount !== request.targetAccount) {
      throw new Error(
        `Authenticated X account does not match publication target ${request.targetAccount}.`,
      );
    }

    return request;
  }
}
