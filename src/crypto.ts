import crypto, { CipherGCM, DecipherGCM } from 'node:crypto';

export interface EncryptionConfig {
  enabled?: boolean;
  passphrase?: string; // or encryption key
  salt?: string;
  algorithm?: 'aes-256-gcm';
}

export class CryptoManager {
  private enabled: boolean;
  private key: Buffer | null = null;
  private algorithm = 'aes-256-gcm' as const;

  constructor(config?: EncryptionConfig) {
    this.enabled =
      config?.enabled ??
      (Boolean(config?.passphrase) || process.env.OBSIDIAN_ENCRYPTION_ENABLED === 'true');
    const passphrase = config?.passphrase || process.env.OBSIDIAN_ENCRYPTION_KEY;
    const salt = config?.salt || process.env.OBSIDIAN_ENCRYPTION_SALT || 'obsidian-agi-workspace-salt';

    if (this.enabled && passphrase) {
      // Derive a 256-bit key using scrypt
      this.key = crypto.scryptSync(passphrase, salt, 32);
    }
  }

  public isEnabled(): boolean {
    return this.enabled && this.key !== null;
  }

  /**
   * Encrypt a text or markdown string using AES-256-GCM.
   * Format output: `<!-- OBSIDIAN_MCP_ENCRYPTED:v1 -->\nENC[AES256_GCM,iv:hex,tag:hex,data:base64]`
   */
  public encryptText(plainText: string): string {
    if (!this.isEnabled()) return plainText;

    const iv = crypto.randomBytes(12); // standard 96-bit IV for GCM
    const cipher = crypto.createCipheriv(this.algorithm, this.key!, iv) as CipherGCM;

    let encrypted = cipher.update(plainText, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('hex');
    const ivHex = iv.toString('hex');

    return `<!-- OBSIDIAN_MCP_ENCRYPTED:v1 -->\nENC[AES256_GCM,iv:${ivHex},tag:${authTag},data:${encrypted}]`;
  }

  /**
   * Decrypt text if it matches encrypted envelope. Returns original text if not encrypted.
   */
  public decryptText(rawText: string): string {
    if (!rawText.includes('OBSIDIAN_MCP_ENCRYPTED:v1') && !rawText.startsWith('ENC[AES256_GCM,')) {
      return rawText;
    }

    if (!this.isEnabled()) {
      throw new Error(
        'Document is encrypted with AES-256-GCM, but encryption passphrase (OBSIDIAN_ENCRYPTION_KEY) is not configured.'
      );
    }

    const match = /ENC\[AES256_GCM,iv:([0-9a-fA-F]+),tag:([0-9a-fA-F]+),data:([A-Za-z0-9+/=]+)\]/.exec(rawText);
    if (!match) {
      return rawText;
    }

    const [, ivHex, tagHex, dataBase64] = match;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');

    const decipher = crypto.createDecipheriv(this.algorithm, this.key!, iv) as DecipherGCM;
    decipher.setAuthTag(tag);

    try {
      let decrypted = decipher.update(dataBase64, 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err: any) {
      throw new Error(`Decryption failed: invalid passphrase or corrupted payload (${err.message})`);
    }
  }

  /**
   * Field-level encrypt sensitive Frontmatter properties (e.g. `secret_*`, `credentials`, `private`).
   */
  public encryptFrontmatter(
    frontmatter: Record<string, any>,
    sensitiveKeys: string[] = ['secret', 'api_key', 'token', 'private']
  ): Record<string, any> {
    if (!this.isEnabled()) return frontmatter;

    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(frontmatter)) {
      const isSensitive = sensitiveKeys.some((s) => k.toLowerCase().includes(s));
      if (isSensitive && typeof v === 'string' && !v.startsWith('ENC[')) {
        result[k] = this.encryptText(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  /**
   * Field-level decrypt sensitive Frontmatter properties.
   */
  public decryptFrontmatter(frontmatter: Record<string, any>): Record<string, any> {
    if (!this.isEnabled()) return frontmatter;

    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(frontmatter)) {
      if (typeof v === 'string' && (v.includes('OBSIDIAN_MCP_ENCRYPTED') || v.startsWith('ENC['))) {
        try {
          result[k] = this.decryptText(v);
        } catch {
          result[k] = v;
        }
      } else {
        result[k] = v;
      }
    }
    return result;
  }
}
