# Changelog

## 2.0.0

- Replaced timestamp reconciliation with SHA-256 hashes and version vectors.
- Added mutually authenticated AES-256-GCM sessions and replay protection.
- Moved pairing keys to Obsidian SecretStorage.
- Added bounded chunked binary-file synchronization.
- Added per-path operation queues and host-coordinated reconciliation.
- Added conflict copies and versioned deletion tombstones.
- Added rename and recursive parent-folder support.
- Added verified backups, staging, rollback, and host-only transactional flush.
- Added connection cleanup, authentication timeouts, and reconnect backoff.
- Rebuilt the project from strict TypeScript with linting and automated tests.
- Removed the duplicated diff-match-patch bundle and tracked local/editor files.

Version 2 uses a new wire protocol and requires Obsidian 1.11.4 or newer.
