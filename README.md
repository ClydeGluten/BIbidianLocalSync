# Local Vault Sync

Local Vault Sync synchronizes an Obsidian vault between a desktop host and desktop or mobile clients on the same local network.

Version 2 uses a host-coordinated protocol with content hashes, version vectors, encrypted sessions, binary-file support, conflict copies, safe deletion, and verified transactional flush backups.

## Requirements

- Obsidian 1.11.4 or newer.
- One desktop Obsidian installation acting as the host.
- Clients that can reach the host's TCP port over the local network.
- The same generated 256-bit pairing key stored in Obsidian SecretStorage on every device.

Protocol v2 is intentionally incompatible with version 1. Upgrade every device together.

## Setup

### Host

1. Install and enable the plugin.
2. Open **Local Vault Sync** settings.
3. Select **Generate** under pairing key tools.
4. Enable **Server mode**.
5. Choose a port and allow that port through the desktop firewall for trusted local networks.
6. Use **Copy key** only while pairing a client. Treat the copied value like a password and clear the clipboard afterward.

### Client

1. Install and enable the plugin.
2. Create a SecretStorage entry containing the pairing key copied from the host.
3. Select that entry under **Pairing secret**.
4. Enter the host IP address or hostname and port.
5. Select **Reconnect**.

On the first authenticated connection, the client pins the host's vault ID. A later connection claiming a different vault ID is rejected before the client sends its proof.

## Synchronization behavior

- SHA-256 hashes determine content equality; filesystem modification times are only a local cache optimization.
- Version vectors distinguish newer changes from concurrent offline edits.
- The desktop host coordinates reconciliation and distributes accepted results to clients.
- Concurrent file edits preserve the host version at the original path and write the peer version to a timestamped conflict path.
- Concurrent deletion and editing preserves the edited file.
- Incoming deletions use Obsidian's configured trash behavior and carry versioned tombstones.
- Text and binary files use the appropriate Vault APIs and encrypted, bounded chunks.
- Renames are synchronized as creation of the new path plus a tombstone for the old path.
- `.obsidian`, `.trash`, configured ignored prefixes, absolute paths, and traversal paths are never accepted from peers.

If any file exceeds the configured maximum size, synchronization stops with an error instead of treating that file as deleted or transferring it partially.

## Transactional flush

Only the desktop host can initiate a flush.

Each client:

1. Scans its current vault state.
2. Creates and verifies a binary backup of every file that would be replaced or removed.
3. Stages requested host files under the configured Obsidian directory.
4. Verifies every staged size and SHA-256 hash.
5. Confirms affected local files did not change during preparation.
6. Applies replacements and then trashes extra files.
7. Restores the verified backup if commit fails.

Backups can be inspected, restored, or deleted from the plugin settings. A flush interrupted before commit leaves current vault files untouched.

## Security model

- Both client and host prove possession of the pairing key using role-separated HMAC-SHA-256 proofs.
- Direction-specific session keys are derived with HKDF-SHA-256.
- Protocol messages are encrypted and authenticated with AES-256-GCM.
- Strict sequence numbers reject replayed, missing, or reordered envelopes.
- Authentication, payload-size, path, manifest, and transfer validation occurs before vault mutation.
- Pairing keys are referenced through Obsidian SecretStorage and are not written into plugin `data.json`.

Limitations:

- The IP address, TCP port, and initial WebSocket connection are visible to the local network.
- The current pre-shared-key session design does not provide forward secrecy. Rotate the pairing key if it may have been exposed.
- A deliberately authorized peer can submit vault changes; only pair devices you control.
- This plugin is not a substitute for independent backups.

## Migrating from version 1

The plaintext v1 shared secret is deliberately not migrated. On first v2 load, generate a new pairing key on the host and pair every client again.

Before upgrading valuable vaults, make an independent copy and test v2 with a disposable vault on each target platform.

## Development

The repository contains TypeScript source and a reproducible npm lockfile.

```bash
npm install
npm run check
```

`npm run check` runs ESLint, strict TypeScript checking, unit and integration tests, a production bundle, and a mobile-load smoke test. `npm run dev` watches source files and rebuilds `main.js`.

Important modules:

- `src/crypto`: mutual authentication, key derivation, and encrypted sessions.
- `src/protocol`: versioned message schemas and validation.
- `src/sync`: metadata, reconciliation, queues, transfers, conflicts, and flush transactions.
- `src/storage`: Obsidian binary/text access and verified backups.
- `src/network`: lifecycle-managed desktop server and native client transport.

## Third-party software

The desktop WebSocket server uses [`ws`](https://github.com/websockets/ws). Development uses the Obsidian API types, TypeScript, esbuild, ESLint, and Vitest. Production code contains no telemetry.

## License

This repository is not open-source licensed. Its public visibility does not grant permission to reuse, modify, or redistribute the code except as required by the hosting platform's terms. Contact the repository owner for permission.
