/**
 * Domain models for the vibe-plugin-tool-git (Ungit) plugin.
 *
 * Plugin contract types (VibePlugin / HostServices / PluginCapabilities /
 * StorageProvider / ServiceRegistry) are imported from
 * `@vibecontrols/plugin-sdk` — do NOT redeclare them here.
 */

export interface UngitStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  port?: number;
  workingDir?: string;
  error?: string;
}

export interface StartBody {
  workingDir?: string;
  port?: number;
}
