import { Notice, Platform, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { App } from "obsidian";
import type LocalSyncPlugin from "./main";

export class LocalSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LocalSyncPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Connection")
      .setHeading();

    new Setting(containerEl)
      .setName("Status")
      .setDesc(this.plugin.connectionStatus);

    new Setting(containerEl)
      .setName("Pairing secret")
      .setDesc("Select the same 256-bit pairing secret on the host and every client.")
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(this.plugin.settings.pairingSecretName)
        .onChange(async (value) => {
          this.plugin.settings.pairingSecretName = value;
          await this.plugin.saveSettings(true);
        }));

    new Setting(containerEl)
      .setName("Pairing key tools")
      .setDesc("Generate a high-entropy key on the host, then copy it into SecretStorage on each client.")
      .addButton((button) => button
        .setButtonText("Generate")
        .setWarning()
        .onClick(async () => {
          await this.plugin.generatePairingKey();
          this.display();
        }))
      .addButton((button) => button
        .setButtonText("Copy key")
        .onClick(async () => {
          await this.plugin.copyPairingKey();
          new Notice("Pairing key copied. Treat it like a password.");
        }));

    new Setting(containerEl)
      .setName("Server mode")
      .setDesc(Platform.isDesktopApp
        ? "Host the authoritative local vault endpoint on this device."
        : "Server mode is unavailable on mobile.")
      .addToggle((toggle) => toggle
        .setDisabled(!Platform.isDesktopApp)
        .setValue(this.plugin.settings.serverMode && Platform.isDesktopApp)
        .onChange(async (value) => {
          this.plugin.settings.serverMode = value;
          await this.plugin.saveSettings(true);
          this.display();
        }));

    if (!this.plugin.settings.serverMode) {
      new Setting(containerEl)
        .setName("Server address")
        .setDesc("Hostname or IP address of the desktop host.")
        .addText((text) => text
          .setPlaceholder("192.168.1.100")
          .setValue(this.plugin.settings.serverAddress)
          .onChange(async (value) => {
            this.plugin.settings.serverAddress = value.trim();
            await this.plugin.saveSettings(false);
          }));
    }

    new Setting(containerEl)
      .setName("Server port")
      .setDesc("TCP port from 1 through 65535.")
      .addText((text) => text
        .setPlaceholder("8080")
        .setValue(String(this.plugin.settings.serverPort))
        .onChange(async (value) => {
          const port = Number(value);
          if (Number.isSafeInteger(port) && port >= 1 && port <= 65535) {
            this.plugin.settings.serverPort = port;
            await this.plugin.saveSettings(false);
          }
        }));

    new Setting(containerEl)
      .setName("Apply connection settings")
      .setDesc("Reconnect after editing the address or port.")
      .addButton((button) => button
        .setButtonText("Reconnect")
        .setCta()
        .onClick(async () => {
          await this.plugin.restartNetwork();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Synchronization")
      .setHeading();

    new Setting(containerEl)
      .setName("Live sync")
      .setDesc("Publish local file changes after a short per-file debounce.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.liveSync)
        .onChange(async (value) => {
          this.plugin.settings.liveSync = value;
          await this.plugin.saveSettings(false);
        }));

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Minutes between manifest checks. Set to 0 to disable periodic checks.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.syncIntervalMinutes))
        .onChange(async (value) => {
          const minutes = Number(value);
          if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) {
            this.plugin.settings.syncIntervalMinutes = minutes;
            await this.plugin.saveSettings(false);
          }
        }));

    new Setting(containerEl)
      .setName("Maximum file size")
      .setDesc("Largest file to synchronize, in MiB. Changing this requires a plugin reload.")
      .addText((text) => text
        .setValue(String(Math.round(this.plugin.settings.maxFileSizeBytes / 1024 / 1024)))
        .onChange(async (value) => {
          const mib = Number(value);
          if (Number.isSafeInteger(mib) && mib >= 1 && mib <= 1024) {
            this.plugin.settings.maxFileSizeBytes = mib * 1024 * 1024;
            await this.plugin.saveSettings(false);
          }
        }));

    new Setting(containerEl)
      .setName("Safety")
      .setHeading();

    new Setting(containerEl)
      .setName("Flush vault")
      .setDesc(this.plugin.settings.serverMode
        ? "Back up affected files, stage and verify replacements, then commit on connected clients."
        : "Flush can only originate from the desktop host.")
      .addButton((button) => button
        .setButtonText("Flush clients")
        .setWarning()
        .setDisabled(!this.plugin.settings.serverMode)
        .onClick(() => this.plugin.initiateFlush()));

    new Setting(containerEl)
      .setName("Maximum backups")
      .setDesc("Verified flush backups to retain. Changing this requires a plugin reload.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.maxBackups))
        .onChange(async (value) => {
          const count = Number(value);
          if (Number.isSafeInteger(count) && count >= 1 && count <= 100) {
            this.plugin.settings.maxBackups = count;
            await this.plugin.saveSettings(false);
          }
        }));

    new Setting(containerEl)
      .setName("Verified backups")
      .setHeading();
    const backupContainer = containerEl.createDiv();
    backupContainer.setText("Loading backups…");
    void this.renderBackups(backupContainer);
  }

  private async renderBackups(container: HTMLElement): Promise<void> {
    try {
      const backups = await this.plugin.getBackups();
      container.empty();
      if (backups.length === 0) {
        container.setText("No transactional backups are available.");
        return;
      }
      for (const backup of backups) {
        new Setting(container)
          .setName(new Date(backup.createdAt).toLocaleString())
          .setDesc(`${backup.fileCount} file(s) · ${backup.id}`)
          .addButton((button) => button
            .setButtonText("Restore")
            .onClick(async () => {
              await this.plugin.restoreBackup(backup.id);
              await this.renderBackups(container);
            }))
          .addButton((button) => button
            .setButtonText("Delete")
            .setWarning()
            .onClick(async () => {
              await this.plugin.deleteBackup(backup.id);
              await this.renderBackups(container);
            }));
      }
    } catch (error) {
      container.setText(`Could not load backups: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
