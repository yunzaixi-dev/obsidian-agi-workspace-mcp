import { describe, it, expect } from 'vitest';
import { CryptoManager } from '../src/crypto.js';

describe('CryptoManager AES-256-GCM', () => {
  const passphrase = 'test-secret-passphrase-2026';
  const salt = 'test-unique-salt-2026';
  const crypto = new CryptoManager({ enabled: true, passphrase, salt });

  it('fails closed when enabled without an explicit key or salt', () => {
    expect(() => new CryptoManager({ enabled: true, passphrase })).toThrow(/salt/i);
    expect(() => new CryptoManager({ enabled: true, salt })).toThrow(/passphrase|key/i);
  });

  it('encrypts and decrypts markdown note body seamlessly', () => {
    const rawMarkdown = `---
title: Confidential Plan
tags: [secret, agi]
---
# Private Architecture Spec
- Highly sensitive token: sk-live-xxxx
`;
    const encrypted = crypto.encryptText(rawMarkdown);
    expect(encrypted).toContain('<!-- OBSIDIAN_MCP_ENCRYPTED:v1 -->');
    expect(encrypted).toContain('ENC[AES256_GCM,');
    expect(encrypted).not.toContain('sk-live-xxxx');

    const decrypted = crypto.decryptText(encrypted);
    expect(decrypted).toBe(rawMarkdown);
  });

  it('fails decryption gracefully with incorrect passphrase', () => {
    const rawMarkdown = 'Top secret data';
    const encrypted = crypto.encryptText(rawMarkdown);

    const wrongCrypto = new CryptoManager({
      enabled: true,
      passphrase: 'wrong-password',
      salt,
    });
    expect(() => wrongCrypto.decryptText(encrypted)).toThrow(/Decryption failed/);
  });

  it('rejects a malformed payload carrying the encrypted marker', () => {
    expect(() =>
      crypto.decryptText('<!-- OBSIDIAN_MCP_ENCRYPTED:v1 -->\nENC[broken]'),
    ).toThrow(/malformed/i);
  });

  it('performs selective Frontmatter key encryption', () => {
    const fm = {
      title: 'Public Note',
      secret_api_key: 'my-super-secret-key-123',
      normal_tag: 'public-data',
    };

    const encryptedFm = crypto.encryptFrontmatter(fm, ['secret_api_key']);
    expect(encryptedFm.title).toBe('Public Note');
    expect(encryptedFm.secret_api_key).toContain('ENC[AES256_GCM,');

    const decryptedFm = crypto.decryptFrontmatter(encryptedFm);
    expect(decryptedFm.secret_api_key).toBe('my-super-secret-key-123');
  });
});
