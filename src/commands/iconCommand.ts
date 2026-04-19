/**
 * "Change Icon" command: presents an OS-themed + codicon-preset picker and
 * updates the node/cluster's icon override in vscrtConfig.json.
 */

import * as vscode from "vscode";
import {
  CUSTOM_ICON_FILES,
  GENERIC_ICON_PRESETS,
} from "../treeView/iconPresets";
import type { CRTTarget } from "../treeView/treeTarget";
import { CommandDeps } from "./types";

interface IconPick extends vscode.QuickPickItem {
  id: string;
}

// OS-labeled entries shown at the top of the picker. Custom SVGs ("mac", "win")
// can't render inside a QuickPick label (no $(…) glyph available), so they
// appear as text-only rows and rely on the in-tree renderer to show the image.
const OS_PICKS: IconPick[] = [
  {
    label: "macOS (Apple logo)",
    description: "Apple logo",
    id: "mac",
  },
  {
    label: "macOS Finder",
    description: "Finder face",
    id: "finder",
  },
  {
    label: "Windows (logo)",
    description: "Windows logo",
    id: "win",
  },
  {
    label: "FreeBSD (Beastie)",
    description: "BSD beastie",
    id: "freebsd",
  },
  {
    label: "Briefcase",
    description: "briefcase glyph",
    id: "briefcase",
  },
  {
    label: "Computer",
    description: "desktop + monitor glyph",
    id: "computer",
  },
  {
    label: "Computer (all-in-one)",
    description: "all-in-one PC glyph",
    id: "computer-aio",
  },
  {
    label: "Laptop",
    description: "laptop glyph",
    id: "laptop",
  },
  {
    label: "Load balancer",
    description: "load-balancer glyph",
    id: "load-balancer",
  },
  {
    label: "Network switch",
    description: "network switch glyph",
    id: "network-switch",
  },
  {
    label: "Wi-Fi",
    description: "Wi-Fi signal",
    id: "wifi",
  },
  {
    label: "$(terminal-powershell) Windows — PowerShell",
    description: "PowerShell codicon",
    id: "terminal-powershell",
  },
  {
    label: "$(terminal-bash) macOS — bash",
    description: "bash prompt codicon",
    id: "terminal-bash",
  },
  {
    label: "$(terminal-linux) Linux",
    description: "Tux penguin",
    id: "terminal-linux",
  },
  {
    label: "$(terminal) Unix",
    description: "generic terminal prompt",
    id: "terminal",
  },
];

/**
 * Validate a user-supplied codicon name for the icon picker. Exported
 * so the unit suite can lock in the allowed character set + length bound
 * without reaching into the webview.
 */
export function isValidCodiconName(raw: string): boolean {
  if (typeof raw !== "string") {return false;}
  if (raw.length === 0 || raw.length > 40) {return false;}
  return /^[a-z0-9-]+$/.test(raw);
}

const PRESET_ICONS = GENERIC_ICON_PRESETS.map((p) => p.id);

export function registerIconCommand(deps: CommandDeps): vscode.Disposable[] {
  const { context, configManager, connectionView } = deps;

  // QuickPick supports an `iconPath` that renders before the label. Use it
  // for custom SVG icons (mac, finder, win, …) so they match the in-tree
  // rendering. Codicon entries keep the `$(name)` inline-glyph syntax.
  const iconUriFor = (id: string): vscode.Uri | undefined => {
    const file = CUSTOM_ICON_FILES[id];
    return file
      ? vscode.Uri.joinPath(context.extensionUri, "media", "icons", file)
      : undefined;
  };
  const decorateOsPick = (p: IconPick): IconPick => {
    const uri = iconUriFor(p.id);
    return uri ? { ...p, iconPath: uri } : p;
  };

  const changeIconCommand = vscode.commands.registerCommand(
    "vsCRT.changeIcon",
    async (target?: CRTTarget) => {
      if (!target) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "vsCRT: select a folder or server to change its icon.",
          ),
        );
        return;
      }

      const picks: IconPick[] = [
        ...OS_PICKS.map(decorateOsPick),
        ...PRESET_ICONS.map((id) => ({
          label: `$(${id}) ${id}`,
          id,
        })),
      ];
      picks.push(
        {
          label: vscode.l10n.t("$(edit) Custom codicon…"),
          description: vscode.l10n.t("Type a codicon name manually"),
          id: "__custom__",
        },
        {
          label: vscode.l10n.t("$(discard) Reset to default"),
          description: vscode.l10n.t("Clear the icon override"),
          id: "__reset__",
        },
      );

      const pick = await vscode.window.showQuickPick(picks, {
        title: vscode.l10n.t("Change Icon — {0}", target.item.label),
        placeHolder: vscode.l10n.t("Pick a codicon"),
        matchOnDescription: true,
        ignoreFocusOut: true,
      });
      if (!pick) {
        return;
      }

      let iconName: string | undefined;
      if (pick.id === "__custom__") {
        iconName = await vscode.window.showInputBox({
          title: vscode.l10n.t("Custom codicon"),
          prompt: vscode.l10n.t(
            "Enter a codicon name (without the 'codicon-' prefix). See https://microsoft.github.io/vscode-codicons/",
          ),
          placeHolder: vscode.l10n.t("e.g. database, rocket, shield"),
          ignoreFocusOut: true,
          validateInput: (value) =>
            /^[a-z0-9-]+$/i.test(value.trim())
              ? null
              : vscode.l10n.t("Use only letters, digits, and hyphens."),
        });
        iconName = iconName?.trim();
        if (!iconName) {
          return;
        }
      } else if (pick.id === "__reset__") {
        iconName = undefined;
      } else {
        iconName = pick.id;
      }

      const ok = await configManager.setIcon(
        target.item.path,
        target.item.type,
        iconName,
      );
      if (!ok) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'vsCRT: could not update icon for "{0}".',
            target.item.label,
          ),
        );
        return;
      }
      await connectionView.reload();
    },
  );

  return [changeIconCommand];
}
