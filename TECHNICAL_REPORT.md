# Local Vault Sync v2 — technical report

## Executive summary

The original plugin was a small JavaScript implementation with a shared secret in plugin data, plaintext WebSocket messages, timestamp-based conflict decisions, text-oriented transfers, and a destructive flush path without a verified transaction boundary. Version 2 replaces that design with a typed, tested protocol and an explicit host-authoritative synchronization model.

The new implementation is substantially safer and easier to maintain. It still assumes that every paired device is trusted: an authenticated peer is allowed to read and mutate synchronized vault content. It also does not provide forward secrecy, so disclosure of the long-lived pairing key plus recorded traffic may weaken historical confidentiality. Those limitations are documented in `SECURITY.md` and the README.

## Implemented changes

### Build and maintainability

- Source moved to strict TypeScript under `src/`.
- Reproducible npm/esbuild build added; `main.js` remains the distributable artifact.
- ESLint, strict type checking, Vitest, and a production/mobile bundle smoke check are part of one quality gate.
- GitHub Actions runs the same gate with Node.js 24.
- Obsolete vendored diff code and an editor undo artifact were removed.

### Authentication and transport security

- The legacy plaintext secret is never migrated into v2 settings.
- Pairing keys are generated as 32 random bytes and referenced through Obsidian SecretStorage.
- Client and server authenticate each other with HMAC-SHA-256 proofs over a transcript containing both device identities, the vault identity, the session identity, and fresh nonces.
- HKDF-SHA-256 derives independent client-to-server and server-to-client AES-256-GCM keys.
- Every encrypted message binds its protocol version, session ID, and exact monotonically increasing sequence number as authenticated data. Replayed, skipped, reordered, or modified envelopes are rejected.
- Authentication timeouts, payload ceilings, a connection limit, bounded incoming transfers, serialized sends, and reconnect backoff reduce resource and lifecycle failures.

### Synchronization correctness

- SHA-256 content hashes replace timestamp-only equality checks.
- Per-file version vectors distinguish newer, older, equal, and concurrent states.
- Deletions are retained as tombstones instead of inferred only from absence.
- The desktop host coordinates reconciliation. Concurrent changes keep the host version at the original path and preserve the peer version at a deterministic conflict path before converging clients.
- Binary files use Obsidian's binary vault APIs and bounded, ordered chunks.
- Transfers verify declared size and SHA-256 content before applying.
- Transfer IDs are bound to the authenticated peer that opened them.
- Per-path queues replace the previous global synchronization flag, preventing unrelated files from blocking one another while serializing mutations to the same path.
- Remote mutation guards prevent vault events caused by synchronization from being published back as fresh local edits.
- Creates make missing parent folders; renames publish an old-path tombstone and a new-path file state.

### Path and data safety

- Paths are normalized and rejected if absolute, traversing, empty, hidden in the configured Obsidian directory, under trash, or under a configured ignored prefix.
- Oversized files fail synchronization explicitly; they are not mistaken for deletions or transferred partially.
- Remote deletions go through Obsidian's trash behavior.
- Protocol, metadata, and backup manifests are validated before use.

### Transactional flush and recovery

- Only the host can originate a flush.
- Each client computes the affected set and creates a verified binary backup before accepting content.
- Replacements are staged below the Obsidian configuration directory and verified before commit.
- A second scan plus per-path hash preconditions aborts if a local file changes after preparation.
- If a partial commit fails, the interrupted state is preserved as another backup and automatic rollback restores the baseline backup.
- Backups have retention control plus restore/delete controls in plugin settings.

## Validation

The final local quality gate passes:

- ESLint: pass
- TypeScript strict type check: pass
- Vitest: 28 tests across 9 files, pass
- Production esbuild bundle: pass
- Mobile module-load smoke check: pass
- Generated JavaScript syntax check: pass
- Git whitespace/error check: pass

Tests cover version-vector relations, path rejection, queue serialization, mutual authentication, encrypted-session tamper/replay behavior, synchronization actions and conflicts, host/client convergence, chunked binary transfers, peer ownership of transfers, verified flush/restore, and abort-on-concurrent-edit behavior.

## Residual risks and recommended follow-up

1. Run a manual two-vault test on desktop-to-desktop and desktop-to-mobile before publishing. Automated tests use in-memory vault/storage doubles and do not replace real Obsidian lifecycle testing.
2. The protocol encrypts payloads but uses a long-lived pre-shared key and has no forward secrecy. A future protocol could use an ephemeral authenticated key exchange.
3. Network metadata remains observable, including IP addresses, port, traffic timing, and approximate encrypted message sizes.
4. A paired device is fully trusted for synchronized content. Pairing-key rotation is the revocation mechanism.
5. Large files are assembled in memory after bounded chunk receipt. Streaming to a temporary file would reduce peak memory in a future version.
6. The repository is deliberately unlicensed. Public visibility does not itself grant open-source reuse rights.

## Release decisions

- The unpublished plugin now uses the consistent ID `local-vault-sync` in both `manifest.json` and `package.json`.
- No `LICENSE` file is included and the npm package metadata declares `UNLICENSED`. The README makes the absence of an open-source license explicit.
