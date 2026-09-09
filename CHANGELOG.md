# Taximeter

## 0.3.2

### Patch Changes

- Refresh the package overview and synchronize the published usage documentation.

## 0.3.1

### Patch Changes

- Add a dashboard screenshot to the GitHub and npm README, include the image in the package, and publish the reorganized installation and source quickstarts with clearer documentation headings.

## 0.3.0

### Minor Changes

- Show effective configuration and source layers in doctor, add validated atomic config editing with exact human amount inputs, and expose temporary start overrides. Enforce optional payment-count budgets using a schema-3 incremental cache with pre-migration backups, and return executable advisory fix hints for blocked payments. The dashboard remains read-only and displays count usage alongside amount usage.

## 0.2.2

### Patch Changes

- Print a one-time stderr notice when the first encrypted CONNECT tunnel arrives, while preserving per-tunnel diagnostics and forwarding behavior. Add a manual Base Sepolia x402 verification workflow and document measured storage-reduction options.

## 0.2.1

### Patch Changes

- Announce legacy ledger migration and save a standalone, WAL-aware schema-1 backup before upgrading. Abort the upgrade if the backup fails, retain completed backups for rollback, and document recovery using a separate database path. Extend the reproducible ledger benchmark to cover larger histories and task/agent partition counts.

## 0.2.0

### Minor Changes

- Default to rejecting parsed payments for unknown assets. Set `policy.unknownAsset` to `allow` to opt in and configure exact contract-address budgets for custom tokens.

  Replace full ledger replay during payment gating with transactional, rebuildable payment projections and exact timestamp-indexed budget sums. Preserve append-only source records, retry and settlement semantics, and precise rolling-window boundaries. Existing databases migrate to schema version 2 when opened; older 0.1.x clients cannot reopen the migrated schema.

## 0.1.2

### Patch Changes

- Exclude development specifications, verification transcripts, design decisions, contribution files, and recording sources from the npm package. Keep the CLI, SDK, dashboard, usage documentation, demo image, license, security guidance, changelog, and example configuration. Link to repository-only documentation from packaged guides.

## 0.1.1

### Patch Changes

- Publish the complete local x402 spend meter after the npm ownership bootstrap. Include the proxy, fetch SDK, exact ledger, budget enforcement, CLI exports, prebuilt dashboard, and tested documentation. Improve release authentication diagnostics and keep package verification aligned with the release version.

## 0.1.0

### Minor Changes

- Introduce the local x402 payment meter: exact append-only accounting, scoped budgets,
  streaming proxy, fetch SDK, CLI reports and exports, and a prebuilt local dashboard.
  Supports x402 v1/v2 exact EVM EIP-3009 authorizations without custody or settlement.
