const obsidian = require('obsidian');
const { diff_match_patch } = require('./diff_match_patch.js');

const DEFAULT_SETTINGS = {
    sharedSecret: 'change-me',
    serverMode: false,
    serverIP: '127.0.0.1',
    serverPort: 8080,
    syncInterval: 2, // Default 2 minutes
};

// Web Crypto API is available on both Desktop and Mobile
async function generateHMAC(secret, data) {
    const enc = new TextEncoder();
    const key = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await window.crypto.subtle.sign("HMAC", key, enc.encode(data));
    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// --- Minimal WebSocket Server Implementation ---
// Only called on Desktop where Buffer is available
function sendWS(socket, text) {
    if (socket.destroyed) return;
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header;
    if (len <= 125) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = len;
    } else if (len <= 65535) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
}

function setupWSSocket(socket, onMessage, onClose) {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
            const opcode = buffer[0] & 0x0f;
            const masked = (buffer[1] & 0x80) === 0x80;
            let payloadLen = buffer[1] & 0x7f;
            let offset = 2;
            
            if (payloadLen === 126) {
                if (buffer.length < 4) return;
                payloadLen = buffer.readUInt16BE(2);
                offset += 2;
            } else if (payloadLen === 127) {
                if (buffer.length < 10) return;
                payloadLen = Number(buffer.readBigUInt64BE(2)); 
                offset += 8;
            }
            
            if (masked) {
                if (buffer.length < offset + 4) return;
                const mask = buffer.slice(offset, offset + 4);
                offset += 4;
                if (buffer.length < offset + payloadLen) return;
                const payload = buffer.slice(offset, offset + payloadLen);
                for (let i = 0; i < payloadLen; i++) payload[i] ^= mask[i % 4];
                if (opcode === 1) onMessage(payload.toString('utf8'), socket);
                else if (opcode === 8) socket.end();
                buffer = buffer.slice(offset + payloadLen);
            } else {
                if (buffer.length < offset + payloadLen) return;
                const payload = buffer.slice(offset, offset + payloadLen);
                if (opcode === 1) onMessage(payload.toString('utf8'), socket);
                else if (opcode === 8) socket.end();
                buffer = buffer.slice(offset + payloadLen);
            }
        }
    });
    socket.on('close', onClose);
    socket.on('error', onClose);
}

// --- Plugin Implementation ---
class LocalSyncPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();

        this.dmp = new diff_match_patch();
        this.syncHistory = await this.loadSyncHistory();
        this.isSyncing = false;
        this.clients = new Set();
        this.wsClient = null;
        this.syncIntervalID = null;

        this.addSettingTab(new LocalSyncSettingTab(this.app, this));

        this.addCommand({
            id: 'force-local-sync',
            name: 'Force Local Sync',
            callback: () => this.forceSync()
        });

        // Setup Network
        this.initializeNetwork();
    }

    async onunload() {
        if (this.server) this.server.close();
        if (this.wsClient) this.wsClient.close();
        if (this.syncIntervalID) window.clearInterval(this.syncIntervalID);
        await this.saveSyncHistory();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.initializeNetwork();
    }

    initializeNetwork() {
        if (this.server) { this.server.close(); this.server = null; }
        if (this.wsClient) { this.wsClient.close(); this.wsClient = null; }
        if (this.syncIntervalID) window.clearInterval(this.syncIntervalID);
        
        if (this.settings.serverMode) {
            this.startServer();
        } else {
            this.connectClient();
        }

        // Setup interval-based periodic sync
        if (this.settings.syncInterval > 0) {
            this.syncIntervalID = window.setInterval(() => {
                this.forceSync();
            }, this.settings.syncInterval * 60 * 1000);
        }
    }

    // --- Sync History state to detect conflicts ---
    async loadSyncHistory() {
        try {
            const data = await this.app.vault.adapter.read('.obsidian/sync-history.json');
            return JSON.parse(data);
        } catch {
            return {};
        }
    }

    async saveSyncHistory() {
        try {
            await this.app.vault.adapter.write('.obsidian/sync-history.json', JSON.stringify(this.syncHistory));
        } catch (e) {
            console.error("Failed to save sync history", e);
        }
    }

    // --- Network: Server ---
    startServer() {
        let http, cryptoNode;
        try {
            http = require('http');
            cryptoNode = require('crypto');
        } catch (e) {
            new obsidian.Notice("Server mode is only supported on Desktop Obsidian.");
            this.settings.serverMode = false;
            this.saveSettings();
            return;
        }

        this.server = http.createServer((req, res) => {
            res.writeHead(404);
            res.end();
        });

        this.server.on('upgrade', (req, socket, head) => {
            const key = req.headers['sec-websocket-key'];
            if (!key) { socket.end(); return; }
            
            const hash = cryptoNode.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                         'Upgrade: websocket\r\n' +
                         'Connection: Upgrade\r\n' +
                         'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n');

            socket.isAuthenticated = false;
            const challenge = cryptoNode.randomBytes(16).toString('hex');
            socket.challenge = challenge;
            sendWS(socket, JSON.stringify({ type: 'AUTH_CHALLENGE', challenge }));

            setupWSSocket(socket, 
                (msg) => this.handleServerMessage(socket, msg), 
                () => this.clients.delete(socket)
            );
        });

        this.server.listen(this.settings.serverPort, '0.0.0.0', () => {
            new obsidian.Notice(`Local Sync Server started on port ${this.settings.serverPort}`);
        });
    }

    async handleServerMessage(socket, msgStr) {
        try {
            const msg = JSON.parse(msgStr);
            if (msg.type === 'AUTH_RESPONSE') {
                const expectedHMAC = await generateHMAC(this.settings.sharedSecret, socket.challenge);
                if (msg.hmac === expectedHMAC) {
                    socket.isAuthenticated = true;
                    this.clients.add(socket);
                    sendWS(socket, JSON.stringify({ type: 'AUTH_SUCCESS' }));
                } else {
                    socket.end();
                }
                return;
            }

            if (!socket.isAuthenticated) return;

            if (msg.type === 'FILE_UPDATE') {
                await this.processIncomingFileUpdate(msg.path, msg.content, msg.mtime);
                // Broadcast to other clients
                for (const client of this.clients) {
                    if (client !== socket) sendWS(client, msgStr);
                }
            } else if (msg.type === 'REQUEST_MANIFEST') {
                const manifest = await this.generateManifest();
                sendWS(socket, JSON.stringify({ type: 'MANIFEST', manifest }));
            } else if (msg.type === 'REQUEST_FILE') {
                try {
                    const content = await this.app.vault.adapter.read(msg.path);
                    const stat = await this.app.vault.adapter.stat(msg.path);
                    sendWS(socket, JSON.stringify({
                        type: 'FILE_UPDATE',
                        path: msg.path,
                        content,
                        mtime: stat.mtime
                    }));
                } catch (e) {
                    // Ignore file read errors
                }
            }
        } catch (e) {
            console.error("Server Message Error", e);
        }
    }

    // --- Network: Client ---
    connectClient() {
        const url = `ws://${this.settings.serverIP}:${this.settings.serverPort}`;
        try {
            this.wsClient = new WebSocket(url);
        } catch (e) {
            console.error("WebSocket connection failed", e);
            return;
        }

        this.wsClient.onmessage = async (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'AUTH_CHALLENGE') {
                    const hmac = await generateHMAC(this.settings.sharedSecret, msg.challenge);
                    this.wsClient.send(JSON.stringify({ type: 'AUTH_RESPONSE', hmac }));
                } else if (msg.type === 'AUTH_SUCCESS') {
                    new obsidian.Notice('Connected to Local Sync Server');
                    this.forceSync(); // Auto sync on connect
                } else if (msg.type === 'FILE_UPDATE') {
                    await this.processIncomingFileUpdate(msg.path, msg.content, msg.mtime);
                } else if (msg.type === 'MANIFEST') {
                    await this.reconcileManifest(msg.manifest);
                }
            } catch (e) {
                console.error("Client onmessage Error", e);
            }
        };

        this.wsClient.onclose = () => {
            setTimeout(() => {
                if (!this.settings.serverMode) this.connectClient();
            }, 5000);
        };
    }

    broadcastMessage(msg) {
        const msgStr = JSON.stringify(msg);
        if (this.settings.serverMode) {
            for (const client of this.clients) {
                sendWS(client, msgStr);
            }
        } else if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            this.wsClient.send(msgStr);
        }
    }

    // --- Sync Logic ---
    async forceSync() {
        if (this.settings.serverMode) {
            // Server broadcasts manifest to all clients
            const manifest = await this.generateManifest();
            this.broadcastMessage({ type: 'MANIFEST', manifest });
        } else if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            // Client requests manifest
            this.wsClient.send(JSON.stringify({ type: 'REQUEST_MANIFEST' }));
        }
    }

    async generateManifest() {
        const files = this.app.vault.getFiles();
        const manifest = {};
        for (const f of files) {
            manifest[f.path] = f.stat.mtime;
        }
        return manifest;
    }

    async reconcileManifest(remoteManifest) {
        const localManifest = await this.generateManifest();

        // Check for files to pull
        for (const path in remoteManifest) {
            const remoteMtime = remoteManifest[path];
            const localMtime = localManifest[path];

            if (!localMtime || remoteMtime > localMtime) {
                // Request file from server
                this.broadcastMessage({ type: 'REQUEST_FILE', path });
            }
        }

        // Check for files to push
        for (const path in localManifest) {
            const localMtime = localManifest[path];
            const remoteMtime = remoteManifest[path];

            if (!remoteMtime || localMtime > remoteMtime) {
                try {
                    const content = await this.app.vault.adapter.read(path);
                    this.broadcastMessage({ type: 'FILE_UPDATE', path, content, mtime: localMtime });
                } catch (e) {}
            }
        }
    }

    async processIncomingFileUpdate(path, newContent, remoteMtime) {
        if (this.isSyncing) return;
        this.isSyncing = true;
        try {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file && file instanceof obsidian.TFile) {
                const localMtime = file.stat.mtime;
                const lastSynced = this.syncHistory[path] || 0;

                // Conflict Resolution Logic
                if (localMtime > lastSynced && localMtime !== remoteMtime) {
                    // Local has offline changes. CONFLICT!
                    const localContent = await this.app.vault.read(file);
                    
                    // Attempt Git-style merge heuristic using diff-match-patch
                    const diffs = this.dmp.diff_main(localContent, newContent);
                    this.dmp.diff_cleanupSemantic(diffs);
                    
                    let hasDeletes = false;
                    for (let d of diffs) {
                        if (d[0] === -1) hasDeletes = true; // Text was removed from local in remote
                    }

                    if (!hasDeletes) {
                        // Remote just added text (no local text was destroyed), safe to merge
                        await this.app.vault.modify(file, newContent);
                        new obsidian.Notice(`Cleanly merged updates in ${path}`);
                    } else {
                        // Fallback: Concatenation (Appending to page)
                        const mergedContent = localContent + "\n\n<<<<<<< REMOTE CONFLICT >>>>>>>\n\n" + newContent;
                        await this.app.vault.modify(file, mergedContent);
                        new obsidian.Notice(`Conflict appended to ${path}`);
                    }
                    
                    this.syncHistory[path] = file.stat.mtime;
                    await this.saveSyncHistory();
                    
                } else {
                    // No local modifications since last sync, safe to overwrite
                    await this.app.vault.modify(file, newContent);
                    this.syncHistory[path] = file.stat.mtime;
                    await this.saveSyncHistory();
                }
            } else if (!file) {
                // File does not exist locally, create it
                const newFile = await this.app.vault.create(path, newContent);
                this.syncHistory[path] = newFile.stat.mtime;
                await this.saveSyncHistory();
            }
        } catch (e) {
            console.error("Error applying file update:", e);
        } finally {
            this.isSyncing = false;
        }
    }
}

class LocalSyncSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const {containerEl} = this;
        containerEl.empty();

        containerEl.createEl('h2', {text: 'Local Vault Sync Settings'});

        new obsidian.Setting(containerEl)
            .setName('Shared Secret')
            .setDesc('Enter a secret string to authenticate connections.')
            .addText(text => text
                .setPlaceholder('Enter secret')
                .setValue(this.plugin.settings.sharedSecret)
                .onChange(async (value) => {
                    this.plugin.settings.sharedSecret = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Sync Interval (Minutes)')
            .setDesc('How often the plugin should automatically check for changes.')
            .addText(text => text
                .setPlaceholder('2')
                .setValue(String(this.plugin.settings.syncInterval))
                .onChange(async (value) => {
                    this.plugin.settings.syncInterval = parseFloat(value) || 2;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Server Mode (Desktop Only)')
            .setDesc('Run the WebSocket server on this device.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.serverMode)
                .onChange(async (value) => {
                    this.plugin.settings.serverMode = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (!this.plugin.settings.serverMode) {
            new obsidian.Setting(containerEl)
                .setName('Server IP')
                .setDesc('IP address of the Desktop running Server Mode.')
                .addText(text => text
                    .setPlaceholder('192.168.1.100')
                    .setValue(this.plugin.settings.serverIP)
                    .onChange(async (value) => {
                        this.plugin.settings.serverIP = value;
                        await this.plugin.saveSettings();
                    }));
        }

        new obsidian.Setting(containerEl)
            .setName('Server Port')
            .setDesc('Port for the WebSocket connection.')
            .addText(text => text
                .setPlaceholder('8080')
                .setValue(String(this.plugin.settings.serverPort))
                .onChange(async (value) => {
                    this.plugin.settings.serverPort = parseInt(value) || 8080;
                    await this.plugin.saveSettings();
                }));
    }
}

module.exports = LocalSyncPlugin;
