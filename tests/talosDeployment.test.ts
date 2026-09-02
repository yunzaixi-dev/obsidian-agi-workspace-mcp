import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const talosTemplate = path.join(root, 'deploy/talos/obsidian-workspace-volume.example.yaml');
const pvTemplate = path.join(root, 'deploy/k8s/encrypted-local-pv.example.yaml');

describe('encrypted storage bootstrap templates', () => {
  it('defines a Talos LUKS2 UserVolume with a non-ambiguous disk selector placeholder', () => {
    const yaml = fs.readFileSync(talosTemplate, 'utf8');
    expect(yaml).toContain('kind: UserVolumeConfig');
    expect(yaml).toContain('name: obsidian-workspace');
    expect(yaml).toContain('provider: luks2');
    expect(yaml).toContain("disk.wwid == 'REPLACE_WITH_VERIFIED_DATA_DISK_WWID'");
  });

  it('defaults to TPM state-locked encryption and never embeds a static passphrase', () => {
    const yaml = fs.readFileSync(talosTemplate, 'utf8');
    expect(yaml).toContain('tpm: {}');
    expect(yaml).toContain('lockToState: true');
    expect(yaml).not.toContain('passphrase:');
    expect(yaml).not.toContain('static:');
  });

  it('prebinds a retained local PV to the single encrypted workspace claim', () => {
    const yaml = fs.readFileSync(pvTemplate, 'utf8');
    expect(yaml).toContain('provisioner: kubernetes.io/no-provisioner');
    expect(yaml).toContain('persistentVolumeReclaimPolicy: Retain');
    expect(yaml).toContain('path: /var/mnt/obsidian-workspace');
    expect(yaml).toContain('name: obsidian-workspace-pvc');
    expect(yaml).toContain('- REPLACE_WITH_VERIFIED_NODE_NAME');
    expect(yaml).not.toContain('- name: REPLACE_WITH_VERIFIED_NODE_NAME');
  });
});
