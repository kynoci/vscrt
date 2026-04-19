/**
 * Centralized filesystem path helpers for the vsCRT on-disk layout.
 *
 * Everything vsCRT writes lives under `~/.vscrt/`:
 *
 *   ~/.vscrt/
 *     vscrtConfig.json          main config (tree + per-node settings)
 *     connections.log           audit trail (rotated at 5 MB → .1)
 *     sessions/*.meta.json      session recordings metadata
 *     sessions/*.cast           session transcripts (when full recording)
 *     backups/<ISO>.json        rolling config backups
 *
 * Keeping these strings in one module makes cross-OS testing easier and
 * prevents a typo in one call site silently writing to a slightly
 * different directory.
 */

import * as os from "os";
import * as path from "path";

export const VSCRT_HOME_NAME = ".vscrt";
export const CONFIG_FILENAME = "vscrtConfig.json";
export const BACKUPS_SUBFOLDER = "backups";
export const SESSIONS_SUBFOLDER = "sessions";
export const CONNECTION_LOG_FILENAME = "connections.log";

/** ~/.vscrt — the root directory for everything vsCRT writes on disk. */
export function vscrtHomeDir(home: string = os.homedir()): string {
  return path.join(home, VSCRT_HOME_NAME);
}

/** ~/.vscrt/vscrtConfig.json — the primary config file. */
export function vscrtConfigFilePath(home: string = os.homedir()): string {
  return path.join(vscrtHomeDir(home), CONFIG_FILENAME);
}

/** ~/.vscrt/backups — rolling backups dir written on every successful save. */
export function vscrtBackupsDir(home: string = os.homedir()): string {
  return path.join(vscrtHomeDir(home), BACKUPS_SUBFOLDER);
}

/** ~/.vscrt/sessions — session metadata and optional transcript payloads. */
export function vscrtSessionsDir(home: string = os.homedir()): string {
  return path.join(vscrtHomeDir(home), SESSIONS_SUBFOLDER);
}

/** ~/.vscrt/connections.log — connection audit log. */
export function vscrtConnectionLogPath(home: string = os.homedir()): string {
  return path.join(vscrtHomeDir(home), CONNECTION_LOG_FILENAME);
}
