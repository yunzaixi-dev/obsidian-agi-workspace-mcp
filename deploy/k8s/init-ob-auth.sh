#!/bin/sh
set -e

echo "=========================================================="
echo " Obsidian Headless (ob) Cluster Bootstrap & Auth Helper"
echo "=========================================================="

PERSISTENT_HOME="${XDG_CONFIG_HOME:-/home/mcp}"
VAULT_PATH="${OBSIDIAN_VAULT_PATH:-/vault}"

echo ">> Ensuring persistent directories exist in ${PERSISTENT_HOME}..."
mkdir -p "${PERSISTENT_HOME}/.config" "${PERSISTENT_HOME}/.local/share" "${VAULT_PATH}"

echo ">> Checking if ob is installed..."
if ! command -v ob >/dev/null 2>&1; then
  echo ">> Installing obsidian-headless pinned version (0.0.14)..."
  npm install -g obsidian-headless@0.0.14
fi

echo ">> Verifying Obsidian Headless CLI..."
ob --version

echo ""
echo ">> [STEP 1] Interactive Login to Obsidian Sync"
echo "   Please enter your Obsidian account email, password, and MFA if prompted."
ob login

echo ""
echo ">> [STEP 2] Listing Remote Vaults..."
ob sync-list-remote

echo ""
read -p "Enter Remote Vault Name or ID to connect: " REMOTE_VAULT
read -p "Enter Device Name for this cluster node [e.g. k8s-mcp-pod-01]: " DEVICE_NAME
DEVICE_NAME="${DEVICE_NAME:-k8s-mcp-pod-01}"

echo ""
echo ">> [STEP 3] Initializing Vault Sync Mapping..."
ob sync-setup --vault "${REMOTE_VAULT}" --path "${VAULT_PATH}" --device-name "${DEVICE_NAME}"

echo ""
echo ">> [STEP 4] Configuring Bidirectional Sync & Conflict Strategy..."
ob sync-config --path "${VAULT_PATH}" --mode bidirectional --conflict-strategy conflict

echo ""
echo ">> [STEP 5] Performing Initial Sync..."
ob sync --path "${VAULT_PATH}"

echo ""
echo "=========================================================="
echo " ✓ Obsidian Headless Sync Bootstrap Completed Successfully!"
echo "   Credentials and E2EE session stored securely in PVC."
echo "=========================================================="
