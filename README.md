# obsidian-agi-workspace-mcp

A security-boundary-first MCP workspace for an Obsidian vault, with controlled X Article publication requests.

> **v0.2 status:** local development and manifest validation are supported. The checked-in Kubernetes manifests are intentionally not production-ready until the encrypted Talos volume, pinned release images, MCP token, Obsidian login, allowed hostname, and target node have been supplied and verified.

## Architecture

```text
Obsidian desktop vault
        ⇅ Obsidian Sync E2EE
Talos LUKS2 UserVolume / one PVC
├── vault/                         mounted only by ob sync
│   └── projects/x-blog/                the only subtree mounted into MCP
│       └── .x-publish/            non-secret requests and receipts
└── ob-home/                       mounted only by ob sync

Authenticated Streamable HTTP MCP
├── read/search/edit allowed notes
├── render_x_preview
├── request_x_publish              no X network call
└── get_x_publication_status

Local obsidian-x-publisher
├── reads the synced request
├── verifies the current Markdown SHA-256
├── requires --yes + --expected-sha
└── invokes local xurl credentials to create/publish an Article
```

### Trust boundaries

- The MCP container does **not** mount the complete vault, Obsidian credentials, or X credentials.
- The `ob` sidecar mounts the complete vault and its own persistent home; MCP does not.
- X OAuth remains in the local `xurl` home. It is never placed in Git, the Obsidian vault, the MCP Pod, Kubernetes manifests, or publication receipts.
- `ob` runs continuously in one sidecar. MCP clients cannot invoke or reconfigure it.
- Network MCP uses stateless Streamable HTTP at `/mcp`, a Bearer token, an HTTP Host allowlist, a 1 MiB request limit, and no wildcard CORS.
- X writes are two-stage: the MCP creates an immutable request; the local publisher creates a draft and later publishes it.
- A request ID is a deterministic idempotency hash over schema version, publication type, account, source path, and source SHA-256.

Encryption at rest does not protect plaintext from a compromised running Pod. The runtime boundaries above remain necessary even with LUKS2.

## MCP tools

| Tool | Side effect | Purpose |
|---|---:|---|
| `create_folder` | Vault write | Create a folder inside the configured boundary. |
| `list_folders` | None | List permitted folders. |
| `get_vault_tree` | None | Return only permitted paths; sibling folders are filtered. |
| `read_note` | None | Read a Markdown note and metadata. |
| `write_note` | Vault write | Create or overwrite a note. |
| `patch_note` | Vault write | Patch body, sections, regex matches, or frontmatter. |
| `search_vault` | None | Search permitted notes. |
| `list_tasks` | None | Collect Markdown tasks. |
| `analyze_workspace_graph` | None | Build the permitted wikilink graph. |
| `delete_item` | Vault write | Trash an item by default; deleting the vault root is rejected. |
| `render_x_preview` | None | Render the verified X Article payload and source hash. |
| `request_x_publish` | Queue write | Create/deduplicate a non-secret publication request. |
| `get_x_publication_status` | None | Read requested/draft-created/published status. |

There is deliberately no `sync_vault_ob`, arbitrary shell, X token inspection, or direct X publish MCP tool.

## Local development

Requirements: Node.js 22+, pnpm 11, and go-task.

```bash
pnpm install --frozen-lockfile
task check
```

Stdio mode:

```bash
OBSIDIAN_VAULT_PATH=/absolute/path/to/vault \
OBSIDIAN_ALLOWED_SUBPATHS=projects/x-blog \
pnpm dev
```

Authenticated HTTP mode:

```bash
# Create the token file outside the repository and chmod it 0600.
OBSIDIAN_VAULT_PATH=/absolute/path/to/vault \
OBSIDIAN_ALLOWED_SUBPATHS=projects/x-blog \
X_PUBLISH_QUEUE_PATH=projects/x-blog/.x-publish \
MCP_TRANSPORT=streamable-http \
MCP_AUTH_TOKEN_FILE=/absolute/private/path/mcp-token \
MCP_ALLOWED_HOSTS=127.0.0.1,localhost \
HOST=127.0.0.1 PORT=8080 \
pnpm dev
```

Health endpoints are `/healthz` and `/readyz`; the MCP endpoint is `/mcp`.

Hermes HTTP client shape:

```yaml
mcp_servers:
  obsidian-workspace:
    url: "https://mcp.example.invalid/mcp"
    headers:
      Authorization: "Bearer <load-this-from-your-secret-management-workflow>"
    sampling:
      enabled: false
```

Do not commit a real token in Hermes configuration examples or this repository.

## X Article workflow

### One-time local setup

Install and authenticate the official `xurl` CLI manually, outside an agent session. Never paste X credentials into chat or add inline secrets to commands. The safe agent-visible check is:

```bash
xurl auth status
```

The account with X credentials is the **only Publisher**.

### Request from MCP

1. Call `render_x_preview` with `sourcePath`.
2. Review title, body length, payload, and `sourceSha256`.
3. Call `request_x_publish` with the same path and target X handle.
4. Wait for Obsidian Sync to report `Fully synced` on the local publisher copy.

### Create and publish locally

Use the request ID and exact source hash returned by MCP:

```bash
export OBSIDIAN_VAULT_PATH=/absolute/path/to/local/vault
export OBSIDIAN_ALLOWED_SUBPATHS=projects/x-blog
export X_PUBLISH_QUEUE_PATH=projects/x-blog/.x-publish

obsidian-x-publisher status <request-id>
obsidian-x-publisher draft <request-id> \
  --expected-sha <source-sha256> --app <xurl-app-name> --yes
obsidian-x-publisher publish <request-id> \
  --expected-sha <source-sha256> --app <xurl-app-name> --yes
```

The publisher refuses a stale or mismatched source hash. Receipts contain only request/hash/status/timestamp and public Article/Post IDs.

Current scope is X Articles. The public API does not provide unrestricted editing of published Articles. Ordinary Post editing has separate X account, plan, and time-window constraints and is not represented as an always-available tool.

## Talos encrypted storage gate

The example `deploy/talos/obsidian-workspace-volume.example.yaml` targets Talos 1.13+ and defines a LUKS2 `UserVolumeConfig` using TPM with `lockToState`. It intentionally contains a nonfunctional WWID placeholder.

Before any apply:

1. Inspect the real node with `talosctl get disks -o yaml` and `talosctl get discoveredvolumes -o yaml`.
2. Prove the selected WWID is the intended **non-system** data disk.
3. Confirm TPM 2.0 and SecureBoot. If unavailable, design and review a KMS key path instead; do not downgrade to a committed static passphrase.
4. Copy the example into the infra repository and replace the WWID there.
5. Preview the exact live-node patch:

   ```bash
   talosctl patch machineconfig \
     --talosconfig <repo-local-talosconfig> \
     --nodes <verified-node> \
     --patch @<reviewed-volume-patch.yaml> \
     --dry-run
   ```

6. Apply only in an approved storage maintenance workflow with a rollback/recovery plan.
7. Verify `volumestatus u-obsidian-workspace`, `mountstatus u-obsidian-workspace`, and the LUKS2 mapper/filesystem chain in `discoveredvolumes`.

The Kubernetes PV example maps `/var/mnt/obsidian-workspace`, pre-binds the exact claim, uses node affinity, and retains data. Replace `REPLACE_WITH_VERIFIED_NODE_NAME` before use.

## Kubernetes deployment gate

`deploy/k8s/deployment.yaml` expects:

- published `0.2.0` MCP and ob-sync images, pinned by digest in the production overlay;
- StorageClass/PV `obsidian-workspace-encrypted` backed by the verified Talos LUKS2 volume;
- Secret `workspace-mcp-auth` with key `token`;
- Hermes clients in the `devbox` namespace;
- the selected node label and `edge-us` toleration;
- the manual bootstrap in `deploy/k8s/bootstrap.example.yaml` to complete before either long-running service starts.

The ob-sync and MCP containers run in separate Pods. The sync Pod can reach DNS and HTTPS; the MCP Pod accepts port 8080 only from `devbox` and has no egress. The only MCP-mounted content is `vault/projects/x-blog`.

Create the MCP Secret from a private file rather than an inline shell value:

```bash
kubectl -n obsidian-workspace create secret generic workspace-mcp-auth \
  --from-file=token=/absolute/private/path/mcp-token \
  --dry-run=client -o yaml > /private/path/workspace-mcp-auth.generated.yaml
kubectl apply -f /private/path/workspace-mcp-auth.generated.yaml
```

Keep the generated Secret manifest outside Git and delete it securely after application.

Bootstrap Obsidian only after the encrypted PVC is Bound. Do not add the bootstrap Pod to Flux:

```bash
kubectl apply -f deploy/k8s/bootstrap.example.yaml
kubectl exec -it -n obsidian-workspace pod/obsidian-workspace-bootstrap -- ob login
kubectl exec -it -n obsidian-workspace pod/obsidian-workspace-bootstrap -- ob sync-list-remote
kubectl exec -it -n obsidian-workspace pod/obsidian-workspace-bootstrap -- \
  ob sync-setup --vault oh-my-obsidian --path /vault --device-name prod-us-workspace-mcp
kubectl exec -it -n obsidian-workspace pod/obsidian-workspace-bootstrap -- \
  ob sync-config --path /vault --mode pull-only --conflict-strategy conflict
kubectl exec -it -n obsidian-workspace pod/obsidian-workspace-bootstrap -- ob sync --path /vault
```

Wait for `Fully synced`; a running Pod is not enough. Stop the old cluster-side continuous sync writer, run one final pull, switch the new client to bidirectional mode, and only then create the sentinel:

```bash
kubectl exec -it -n obsidian-workspace pod/obsidian-workspace-bootstrap -- \
  ob sync-config --path /vault --mode bidirectional --conflict-strategy conflict
kubectl exec -it -n obsidian-workspace pod/obsidian-workspace-bootstrap -- ob sync --path /vault
kubectl exec -n obsidian-workspace pod/obsidian-workspace-bootstrap -- \
  sh -c 'touch /home/obsidian/.bootstrap-complete'
kubectl delete -n obsidian-workspace pod/obsidian-workspace-bootstrap
```

Both Deployments wait for that sentinel, preventing an empty or partially initialized vault from being exposed through MCP.

## Security notes

- Symbolic-link traversal is rejected for every resolved path.
- Allowed-subpath ancestors may be traversed only for filtered tree display; ordinary reads and writes must be inside an allowed subtree.
- Publication requests use atomic no-clobber creation and receipts use atomic replacement.
- HTTP token comparison uses constant-sized SHA-256 digests with timing-safe comparison.
- The Kubernetes service is ClusterIP-only and guarded by a default-deny NetworkPolicy.
- All containers run non-root, drop Linux capabilities, disallow privilege escalation, use a read-only root filesystem, and do not receive a service-account token.
- `src/crypto.ts` remains a field/envelope utility; it is not presented as full-vault encryption. Talos LUKS2 protects persistent storage and Obsidian Sync E2EE protects the remote copy.

## Verification

```bash
task check
task manifests:validate
task images:build
```

Production acceptance additionally requires a real authenticated MCP client call, an Obsidian bidirectional sync probe, LUKS2 readback, and an X **draft** call before any public Article publish.

## License

[MIT](LICENSE) © 2026 [yunzaixi-dev](https://github.com/yunzaixi-dev)
