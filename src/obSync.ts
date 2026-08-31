import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ObSyncStatus {
  authenticated: boolean;
  activeVault?: string;
  syncMode?: string;
  lastSyncMessage?: string;
  rawOutput?: string;
}

export class ObSyncManager {
  private obBinary: string;
  private vaultPath: string;

  constructor(vaultPath: string, obBinary: string = 'ob') {
    this.vaultPath = vaultPath;
    this.obBinary = process.env.OB_BIN_PATH || obBinary;
  }

  /**
   * Check if obsidian-headless CLI (`ob`) is installed and available.
   */
  public async isObAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.obBinary, ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check current synchronization status via `ob sync-status` or checking remote list.
   */
  public async getSyncStatus(): Promise<ObSyncStatus> {
    const available = await this.isObAvailable();
    if (!available) {
      return {
        authenticated: false,
        rawOutput: `CLI '${this.obBinary}' not found on PATH.`,
      };
    }

    try {
      const { stdout } = await execFileAsync(this.obBinary, ['sync-list-remote']);
      return {
        authenticated: true,
        rawOutput: stdout.trim(),
      };
    } catch (err: any) {
      const isAuthError =
        err.message.includes('not logged in') ||
        err.message.includes('Authentication') ||
        err.message.includes('login');
      return {
        authenticated: !isAuthError,
        rawOutput: err.message,
      };
    }
  }

  /**
   * Trigger an explicit sync pass via `ob sync --path <vaultPath>`.
   */
  public async triggerSync(): Promise<{ success: boolean; output: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(this.obBinary, ['sync', '--path', this.vaultPath]);
      return {
        success: true,
        output: (stdout + '\n' + stderr).trim(),
      };
    } catch (err: any) {
      return {
        success: false,
        output: err.message,
      };
    }
  }

  /**
   * Configure sync strategy for the target vault.
   */
  public async configureSync(options: {
    mode?: 'bidirectional' | 'pull-only' | 'mirror-remote';
    conflictStrategy?: 'conflict' | 'merge';
  }): Promise<{ success: boolean; output: string }> {
    const args = ['sync-config', '--path', this.vaultPath];
    if (options.mode) {
      args.push('--mode', options.mode);
    }
    if (options.conflictStrategy) {
      args.push('--conflict-strategy', options.conflictStrategy);
    }

    try {
      const { stdout, stderr } = await execFileAsync(this.obBinary, args);
      return {
        success: true,
        output: (stdout + '\n' + stderr).trim(),
      };
    } catch (err: any) {
      return {
        success: false,
        output: err.message,
      };
    }
  }
}
