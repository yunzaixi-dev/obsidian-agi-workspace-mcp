import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LocalXPublisher,
  XPublicationQueue,
  executeXurl,
  type XurlExecutor,
} from './xPublishing.js';

interface PublisherCliDependencies {
  env?: Record<string, string | undefined>;
  execute?: XurlExecutor;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface ParsedArguments {
  command?: string;
  requestId?: string;
  yes: boolean;
  expectedSha256?: string;
  app?: string;
}

function parseArguments(argv: string[]): ParsedArguments {
  const [command, requestId, ...rest] = argv;
  const result: ParsedArguments = { command, requestId, yes: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--yes') {
      result.yes = true;
    } else if (arg === '--expected-sha') {
      result.expectedSha256 = rest[++index];
    } else if (arg === '--app') {
      result.app = rest[++index];
    } else {
      throw new Error(`Unknown publisher argument: ${arg}`);
    }
  }
  return result;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function help(): string {
  return [
    'Usage:',
    '  obsidian-x-publisher status <request-id>',
    '  obsidian-x-publisher draft <request-id> --expected-sha <sha256> --yes [--app <name>]',
    '  obsidian-x-publisher publish <request-id> --expected-sha <sha256> --yes [--app <name>]',
    '',
    'Required environment:',
    '  OBSIDIAN_VAULT_PATH, X_PUBLISH_QUEUE_PATH',
    'Optional environment:',
    '  OBSIDIAN_ALLOWED_SUBPATHS',
  ].join('\n');
}

export async function runPublisherCli(
  argv: string[],
  dependencies: PublisherCliDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      stdout(help());
      return 0;
    }
    const parsed = parseArguments(argv);
    const requestId = required(parsed.requestId, 'request ID');
    const queue = new XPublicationQueue({
      vaultPath: required(env.OBSIDIAN_VAULT_PATH, 'OBSIDIAN_VAULT_PATH'),
      allowedSubpaths: env.OBSIDIAN_ALLOWED_SUBPATHS
        ?.split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      queuePath: required(env.X_PUBLISH_QUEUE_PATH, 'X_PUBLISH_QUEUE_PATH'),
    });

    if (parsed.command === 'status') {
      stdout(JSON.stringify(await queue.getStatus(requestId), null, 2));
      return 0;
    }

    const confirmation = {
      yes: parsed.yes,
      expectedSha256: required(parsed.expectedSha256, '--expected-sha'),
      app: parsed.app,
    };
    const publisher = new LocalXPublisher(queue, dependencies.execute ?? executeXurl);
    if (parsed.command === 'draft') {
      stdout(JSON.stringify(await publisher.createDraft(requestId, confirmation), null, 2));
      return 0;
    }
    if (parsed.command === 'publish') {
      stdout(JSON.stringify(await publisher.publishDraft(requestId, confirmation), null, 2));
      return 0;
    }
    throw new Error(`Unknown publisher command: ${parsed.command ?? ''}`);
  } catch (error: any) {
    stderr(`ERROR: ${error?.message ?? String(error)}`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await runPublisherCli(process.argv.slice(2));
}
