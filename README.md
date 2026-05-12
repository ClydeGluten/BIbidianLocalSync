# Local Vault Sync for Obsidian

A lightweight, zero-dependency plugin to synchronize your Obsidian vault securely over your local network using WebSockets.

## Features

1. **Live Sync**: Instantly sync changes across devices currently connected to the local network using a persistent WebSocket connection.
2. **Shared Secret Authentication**: Connections are authenticated using an HMAC-SHA256 challenge-response mechanism based on a user-defined shared secret. This ensures no third parties can sync or access your vault on the local network.
3. **Conflict Resolution**: Resolves conflicts when devices go offline and edit the same file. It intelligently compares modification times against the last known sync time. If conflicts are detected, it creates a `[filename]_conflict_[timestamp].md` file to ensure no data is lost.
4. **Force Sync**: Provides an Obsidian command to manually trigger a full synchronization, requesting and parsing the full file manifest from the remote device.

## Acknowledgements & Credits

- The **Conflict Resolution** logic structurally follows best practices established by robust sync tools, particularly inspired by the design logic of [Remotely Save](https://github.com/remotely-save/remotely-save) (which creates conflict files based on timestamp differences).
- This plugin bundles [Google's diff-match-patch](https://github.com/google/diff-match-patch) library for future expansions into text-level merging capabilities.

## Setup Instructions

1. Install the plugin in your Obsidian vault.
2. Enable it in settings.
3. **On your primary Desktop (Host):**
   - Go to settings, set a **Shared Secret**.
   - Toggle **Server Mode (Desktop Only)** to ON.
   - Note the IP address of your machine on the local network.
4. **On your other devices (Clients):**
   - Go to settings, enter the same **Shared Secret**.
   - Toggle **Server Mode** OFF.
   - Enter the **Server IP** of your Desktop.
5. Devices will connect automatically and begin live-syncing!
