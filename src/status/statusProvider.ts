/**
 * Populates the Status tree view with OS / WSL / sshpass availability. Probes
 * host state via async child-process calls (with 5 s timeouts) so the
 * extension host isn't blocked while the tree renders.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "../log";
import { SshAgentStatus, detectSshAgent } from "../remote";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 5000;

const SSHPASS_PATH =
  process.platform === "win32"
    ? "C:\\Windows\\System32\\OpenSSH\\sshpass.exe"
    : process.platform === "darwin"
      ? "/usr/local/bin/sshpass"
      : "/usr/bin/sshpass";

/** TreeItem that can carry nested children for the STATUS view */
class StatusTreeItem extends vscode.TreeItem {
  children?: vscode.TreeItem[];
}

export class StatusProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element && element instanceof StatusTreeItem && element.children) {
      return element.children;
    }
    return this.getRootItems();
  }

  private async getRootItems(): Promise<vscode.TreeItem[]> {
    const items: vscode.TreeItem[] = [];
    const platform = process.platform;

    items.push(buildOsItem(platform));

    // Run platform probes concurrently so a slow WSL doesn't serialize sshpass.
    const [wsl, sshpassFoundPaths, agent, sftpPath, scpPath] = await Promise.all([
      platform === "win32" ? detectWsl() : Promise.resolve(null),
      detectSshpass(platform),
      detectSshAgent(),
      detectBinary(platform, platform === "win32" ? "sftp.exe" : "sftp"),
      detectBinary(platform, platform === "win32" ? "scp.exe" : "scp"),
    ]);
    const sshpassExists = sshpassFoundPaths.length > 0;

    // On Windows, sshpass and WSL sshpass are alternatives — when at least
    // one is available, downgrade the missing one's icon from red ✗ to a
    // softer orange ring (still visible, but not a hard failure).
    const downgradeMissing =
      platform === "win32" && (sshpassExists || (wsl?.sshpassOk ?? false));

    const icons = buildIconFactories(downgradeMissing);

    if (platform === "win32" && wsl) {
      items.push(buildWslItem(wsl, icons));
      if (wsl.installed) {
        items.push(buildWslSshpassItem(wsl, icons));
      }
    }

    items.push(
      buildSshpassItem(platform, sshpassFoundPaths, sshpassExists, icons),
    );
    items.push(buildBinaryItem("sftp", sftpPath, icons));
    items.push(buildBinaryItem("scp", scpPath, icons));
    items.push(buildSshAgentItem(agent, icons));

    return items;
  }
}

/**
 * Generic PATH-walker for a single binary (sftp / scp). Returns the
 * first resolved path or `null` when the binary isn't found.
 *
 * Exported (`__test`) so unit tests can hit `which` / `where` against
 * a real binary (`true` / `sh` / etc.) without a full status render.
 */
export async function detectBinary(
  platform: NodeJS.Platform,
  binary: string,
): Promise<string | null> {
  const probe = platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(probe, [binary], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: "utf-8",
    });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first ?? null;
  } catch (err) {
    logProbeFailure(`${probe} ${binary}`, err);
    return null;
  }
}

/** Exported so the `TreeItem` shape can be pinned by unit tests. */
export function buildBinaryItem(
  label: string,
  foundPath: string | null,
  icons: IconFactories,
): vscode.TreeItem {
  const item = new vscode.TreeItem(foundPath ? `${label}: found` : `${label}: missing`);
  item.iconPath = foundPath ? icons.ok() : icons.missing();
  if (foundPath) {
    item.description = foundPath;
    item.tooltip = `${label} is available at ${foundPath}.`;
  } else {
    item.tooltip = `${label} is not on PATH. The SFTP browser / terminal will fail until it's installed.`;
  }
  return item;
}


/* -----------------------------------------------------------------------
 *   DETECTION HELPERS
 * --------------------------------------------------------------------- */

interface WslStatus {
  installed: boolean;
  distros: string[];
  defaultDistro: string;
  sshpassOk: boolean;
}

async function detectWsl(): Promise<WslStatus> {
  let installed = false;
  let distros: string[] = [];
  let defaultDistro = "";
  let sshpassOk = false;

  try {
    const { stdout } = await execFileAsync("wsl", ["--list", "--quiet"], {
      timeout: PROBE_TIMEOUT_MS,
      // WSL emits UTF-16LE on stdout; fall back to UTF-8 for newer distros.
      encoding: "utf-8",
    });
    const text = stdout.replace(/\0/g, "").trim();
    distros = text.split(/\r?\n/).filter(Boolean);
    if (distros.length > 0) {
      installed = true;
    }
  } catch (err) {
    logProbeFailure("wsl --list --quiet", err);
  }

  if (installed) {
    // Use `sh -c` explicitly so $WSL_DISTRO_NAME is expanded inside the distro.
    try {
      const { stdout } = await execFileAsync(
        "wsl",
        ["--", "sh", "-c", "echo $WSL_DISTRO_NAME"],
        { timeout: PROBE_TIMEOUT_MS, encoding: "utf-8" },
      );
      defaultDistro = stdout.replace(/\0/g, "").trim();
    } catch (err) {
      logProbeFailure("wsl -- sh -c 'echo $WSL_DISTRO_NAME'", err);
    }
    // `command -v` is a shell builtin, so route through `sh -c`.
    try {
      await execFileAsync(
        "wsl",
        ["--", "sh", "-c", "command -v sshpass"],
        { timeout: PROBE_TIMEOUT_MS, encoding: "utf-8" },
      );
      sshpassOk = true;
    } catch (err) {
      logProbeFailure("wsl -- sh -c 'command -v sshpass'", err);
    }
  }

  return { installed, distros, defaultDistro, sshpassOk };
}

async function detectSshpass(platform: NodeJS.Platform): Promise<string[]> {
  const found: string[] = [];
  if (fs.existsSync(SSHPASS_PATH)) {
    found.push(SSHPASS_PATH);
  }
  if (platform === "win32") {
    // Also check PATH (catches winget installs like xhcoding.sshpass-win32).
    try {
      const { stdout } = await execFileAsync("where", ["sshpass"], {
        timeout: PROBE_TIMEOUT_MS,
        encoding: "utf-8",
      });
      for (const line of stdout.split(/\r?\n/)) {
        const path = line.trim();
        if (path && !found.includes(path)) {
          found.push(path);
        }
      }
    } catch (err) {
      logProbeFailure("where sshpass", err);
    }
  }
  return found;
}

/**
 * Detection probes are *expected* to fail on systems that don't have the
 * tool installed (e.g. WSL on non-Windows, sshpass on a fresh Linux box),
 * so we don't surface a dialog to the user. But we log the failure so an
 * unexpected error (timeout, permission denied, crash) is visible in the
 * "Extension Host" output panel and doesn't vanish as "Not found".
 */
function logProbeFailure(command: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  const codeSuffix = code ? ` [${code}]` : "";
  log.warn(`probe \`${command}\` failed${codeSuffix}: ${message}`);
}

/* -----------------------------------------------------------------------
 *   TREE ITEM BUILDERS
 * --------------------------------------------------------------------- */

function buildOsItem(platform: NodeJS.Platform): vscode.TreeItem {
  const osLabel =
    platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux";
  const osIcon =
    platform === "win32"
      ? "window"
      : platform === "darwin"
        ? "device-desktop"
        : "terminal-linux";
  const item = new vscode.TreeItem(`OS: ${osLabel}`);
  item.iconPath = new vscode.ThemeIcon(osIcon);
  item.description = `${process.arch}, ${process.version}`;
  return item;
}

interface IconFactories {
  missing: () => vscode.ThemeIcon;
  ok: () => vscode.ThemeIcon;
}

function buildIconFactories(downgradeMissing: boolean): IconFactories {
  return {
    missing: (): vscode.ThemeIcon =>
      downgradeMissing
        ? new vscode.ThemeIcon(
            "circle-large-outline",
            new vscode.ThemeColor("notificationsWarningIcon.foreground"),
          )
        : new vscode.ThemeIcon(
            "close",
            new vscode.ThemeColor("testing.iconFailed"),
          ),
    ok: (): vscode.ThemeIcon =>
      new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("testing.iconPassed"),
      ),
  };
}

function buildWslItem(
  wsl: WslStatus,
  icons: IconFactories,
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    wsl.installed ? "WSL: Installed" : "WSL: Not found",
  );
  item.iconPath = wsl.installed ? icons.ok() : icons.missing();
  item.description = wsl.installed
    ? wsl.distros.join(", ")
    : "Click for install instructions";
  if (!wsl.installed) {
    item.command = { command: "vsCRT.wslHelp", title: "Install WSL" };
  }
  return item;
}

function buildWslSshpassItem(
  wsl: WslStatus,
  icons: IconFactories,
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    wsl.sshpassOk ? "WSL sshpass: Installed" : "WSL sshpass: Not found",
  );
  item.iconPath = wsl.sshpassOk ? icons.ok() : icons.missing();
  const distroLabel = wsl.defaultDistro || "default distro";
  item.description = wsl.sshpassOk
    ? distroLabel
    : `Not in ${distroLabel} — click for install instructions`;
  if (!wsl.sshpassOk) {
    item.command = {
      command: "vsCRT.sshpassWslHelp",
      title: "Install sshpass in WSL",
    };
  }
  return item;
}

function buildSshpassItem(
  platform: NodeJS.Platform,
  foundPaths: string[],
  exists: boolean,
  icons: IconFactories,
): vscode.TreeItem {
  const item = new StatusTreeItem(
    exists ? "sshpass: Installed" : "sshpass: Not found",
  );
  item.iconPath = exists ? icons.ok() : icons.missing();
  if (exists) {
    item.description = `${foundPaths.length} found`;
    item.tooltip = foundPaths.join("\n");
    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    item.children = foundPaths.map((p) => {
      const child = new vscode.TreeItem(p);
      child.iconPath = new vscode.ThemeIcon("file");
      child.tooltip = p;
      return child;
    });
    return item;
  }
  item.description = "Click for install instructions";
  item.command =
    platform === "darwin"
      ? { command: "vsCRT.sshpassMacHelp", title: "Install sshpass" }
      : platform === "linux"
        ? { command: "vsCRT.sshpassLinuxHelp", title: "Install sshpass" }
        : { command: "vsCRT.sshpassWinHelp", title: "Install sshpass" };
  return item;
}

function buildSshAgentItem(
  status: SshAgentStatus,
  icons: IconFactories,
): vscode.TreeItem {
  const label = status.keysLoaded
    ? `ssh-agent: ${status.keyCount} key${status.keyCount === 1 ? "" : "s"} loaded`
    : status.socketSet
      ? "ssh-agent: Reachable, no keys loaded"
      : "ssh-agent: Not detected";
  const item = new StatusTreeItem(label);
  item.iconPath = status.keysLoaded ? icons.ok() : icons.missing();
  item.description = status.socketSet ? "SSH_AUTH_SOCK set" : "SSH_AUTH_SOCK unset";
  if (status.message) {
    item.tooltip = status.message;
  } else if (status.keysLoaded) {
    item.tooltip =
      "ssh-agent keys will be used automatically for servers whose identityFile is left blank.";
  }
  return item;
}
