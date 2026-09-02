import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployment = fs.readFileSync(path.join(root, 'deploy/k8s/deployment.yaml'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'deploy/k8s/bootstrap.example.yaml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

function mcpContainerYaml(): string {
  const start = deployment.indexOf('- name: mcp-server');
  const end = deployment.indexOf('\n      volumes:', start);
  return deployment.slice(start, end);
}

describe('hardened Kubernetes deployment contract', () => {
  it('keeps the Obsidian credential home out of the MCP container', () => {
    expect(mcpContainerYaml()).not.toContain('home-storage');
    expect(mcpContainerYaml()).not.toContain('/home/mcp');
    expect(mcpContainerYaml()).not.toContain('/home/obsidian');
    expect(mcpContainerYaml()).not.toContain('XDG_CONFIG_HOME');
  });

  it('mounts only the selected X blog subtree into the MCP container', () => {
    expect(mcpContainerYaml()).toContain('subPath: vault/projects/x-blog');
    expect(mcpContainerYaml()).toContain('mountPath: /workspace/x-blog');
    expect(mcpContainerYaml()).toContain('value: "/workspace"');
    expect(mcpContainerYaml()).toContain('value: "x-blog"');
    expect(mcpContainerYaml()).toContain('value: "x-blog/.x-publish"');
  });

  it('uses one encrypted workspace PVC and separates vault and ob home with subpaths', () => {
    expect(deployment.match(/kind: PersistentVolumeClaim/g)).toHaveLength(1);
    expect(deployment).toContain('name: obsidian-workspace-pvc');
    expect(deployment).not.toContain('name: obsidian-home-pvc');
    expect(deployment).toContain('subPath: vault');
    expect(deployment).toContain('subPath: ob-home');
  });

  it('runs ob sync and MCP in separate Pods on the selected Hermes node', () => {
    expect(deployment.match(/kind: Deployment/g)).toHaveLength(2);
    expect(deployment).toContain('name: obsidian-workspace-sync');
    expect(deployment).toContain('name: obsidian-agi-workspace-mcp');
    expect(deployment.match(/kubernetes.io\/hostname: prod-us-research-01/g)).toHaveLength(2);
    expect(deployment.match(/key: edge-us/g)).toHaveLength(2);
  });

  it('waits for an explicit bootstrap sentinel before either service starts', () => {
    expect(deployment.match(/\.bootstrap-complete/g)).toHaveLength(2);
    expect(deployment).not.toContain('waiting for interactive ob login/bootstrap in persistent home');
  });

  it('loads MCP authentication from a mounted Secret file', () => {
    expect(mcpContainerYaml()).toContain('name: MCP_AUTH_TOKEN_FILE');
    expect(mcpContainerYaml()).toContain('value: "/run/secrets/mcp/token"');
    expect(mcpContainerYaml()).toContain('name: mcp-auth');
    expect(deployment).toContain('secretName: workspace-mcp-auth');
  });

  it('uses Streamable HTTP without floating image tags', () => {
    expect(mcpContainerYaml()).toContain('value: "streamable-http"');
    expect(deployment).not.toMatch(/image:\s*[^\n]+:latest/);
    expect(deployment).not.toContain('http-sse');
  });

  it('does not install runtime dependencies during Pod startup', () => {
    expect(deployment).not.toContain('npm install');
    expect(dockerfile).toContain('FROM node:22-alpine AS obsidian-sync');
    expect(dockerfile).toContain('obsidian-headless@0.0.14');
  });

  it('ships component-specific NetworkPolicies and admits MCP only from devbox', () => {
    expect(deployment.match(/kind: NetworkPolicy/g)).toHaveLength(2);
    expect(deployment).toContain('app.kubernetes.io/component: mcp-server');
    expect(deployment).toContain('app.kubernetes.io/component: obsidian-sync');
    expect(deployment).toContain('kubernetes.io/metadata.name: devbox');
    expect(deployment).not.toContain('kubernetes.io/metadata.name: hermes');
    expect(deployment).toContain('port: 8080');
  });

  it('provides a manual bootstrap Pod without credentials in arguments', () => {
    expect(bootstrap).toContain('name: obsidian-workspace-bootstrap');
    expect(bootstrap).toContain('claimName: obsidian-workspace-pvc');
    expect(bootstrap).toContain('subPath: ob-home');
    expect(bootstrap).toContain('subPath: vault');
    expect(bootstrap).not.toContain('--email');
    expect(bootstrap).not.toContain('--password');
    expect(bootstrap).not.toContain('--mfa');
  });

  it('builds separate MCP and ob-sync targets without publishing latest', () => {
    expect(ci).toContain('target: runner');
    expect(ci).toContain('target: obsidian-sync');
    expect(ci).toContain('type=semver,pattern={{version}}');
    expect(ci).not.toContain('type=raw,value=latest');
  });
});
