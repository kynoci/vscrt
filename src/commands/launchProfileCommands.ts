/**
 * Multi-session launch profiles. A profile is a named list of server
 * paths; running it opens every target in its own terminal with an
 * optional stagger. Useful for morning/pre-deploy/post-incident routines
 * that span folders.
 *
 * Commands:
 *   vsCRT.runLaunchProfile       — QuickPick over defined profiles + launch.
 *   vsCRT.addLaunchProfile       — create a new profile via QuickPick-over-servers.
 *   vsCRT.deleteLaunchProfile    — remove a profile by name (with confirm).
 *
 * Edit is intentionally "open the config file" for now — the form-based
 * editor is larger follow-up work. Users get the runtime behaviour
 * immediately + can edit as JSON.
 */

import * as vscode from "vscode";
import {
  CRTConfig,
  CRTConfigNode,
  CRTLaunchProfile,
  CRTLaunchTarget,
  uniqueName,
} from "../config/vscrtConfig";
import { findNodeByPath } from "../config/vscrtConfigPaths";
import { log } from "../log";
import type { CommandDeps } from "./types";

export interface ResolvedTarget {
  target: CRTLaunchTarget;
  node: CRTConfigNode;
}

export interface ResolveTargetsResult {
  resolved: ResolvedTarget[];
  missing: string[];
}

export function resolveTargets(
  cfg: CRTConfig,
  profile: CRTLaunchProfile,
): ResolveTargetsResult {
  const resolved: ResolvedTarget[] = [];
  const missing: string[] = [];
  for (const target of profile.targets) {
    const node = findNodeByPath(cfg, target.nodePath);
    if (!node) {
      missing.push(target.nodePath);
      continue;
    }
    resolved.push({ target, node });
  }
  return { resolved, missing };
}

/** Pure helper: sort targets by their delayMs ascending (undefined = 0). */
export function orderByDelay(
  targets: readonly ResolvedTarget[],
): ResolvedTarget[] {
  return [...targets].sort(
    (a, b) => (a.target.delayMs ?? 0) - (b.target.delayMs ?? 0),
  );
}

export function registerLaunchProfileCommands(
  deps: CommandDeps,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vsCRT.runLaunchProfile", async () => {
      await runProfile(deps);
    }),
    vscode.commands.registerCommand("vsCRT.addLaunchProfile", async () => {
      await addProfile(deps);
    }),
    vscode.commands.registerCommand("vsCRT.deleteLaunchProfile", async () => {
      await deleteProfile(deps);
    }),
  ];
}

async function runProfile(deps: CommandDeps): Promise<void> {
  const cfg = await deps.configManager.loadConfig();
  const profiles = cfg?.launchProfiles ?? [];
  if (profiles.length === 0) {
    const add = "Add Profile";
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "vsCRT: no launch profiles defined yet. Add one with 'vsCRT: Add Launch Profile'.",
      ),
      add,
    );
    if (pick === add) {
      await vscode.commands.executeCommand("vsCRT.addLaunchProfile");
    }
    return;
  }
  const picked = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p.name,
      description: p.description,
      detail: `${p.targets.length} target(s)`,
      profile: p,
    })),
    {
      title: vscode.l10n.t("vsCRT: Run Launch Profile"),
      placeHolder: vscode.l10n.t("Pick a profile to open all its servers."),
    },
  );
  if (!picked) {return;}

  if (!cfg) {return;}
  const { resolved, missing } = resolveTargets(cfg, picked.profile);
  if (resolved.length === 0) {
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "vsCRT: profile '{0}' has no resolvable targets.",
        picked.profile.name,
      ),
    );
    return;
  }
  if (missing.length > 0) {
    log.warn(
      `launchProfile '${picked.profile.name}' skipping missing targets: ${missing.join(", ")}`,
    );
  }
  const ordered = orderByDelay(resolved);
  const started = Date.now();
  for (const { target, node } of ordered) {
    const delay = target.delayMs ?? 0;
    const wait = Math.max(0, delay - (Date.now() - started));
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      await deps.sshService.connectFromConfig(
        node,
        target.terminalLocation ?? "panel",
      );
    } catch (err) {
      log.error(`launchProfile: ${target.nodePath} failed:`, err);
    }
  }
}

async function addProfile(deps: CommandDeps): Promise<void> {
  const cfg = (await deps.configManager.loadConfig()) ?? {};
  // Flatten all servers for the target-picker. Reuses the quickConnect
  // flattening pattern — slash-joined paths are stable names here.
  const allPaths: string[] = [];
  walkNodesPaths(cfg, "", allPaths);
  if (allPaths.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "vsCRT: add at least one server before creating a launch profile.",
      ),
    );
    return;
  }

  const name = await vscode.window.showInputBox({
    title: vscode.l10n.t("vsCRT: Launch Profile — name"),
    prompt: vscode.l10n.t(
      "A short identifier. Must be unique among profiles.",
    ),
    validateInput: (v) =>
      v.trim() ? null : vscode.l10n.t("Name cannot be empty."),
  });
  if (!name) {return;}

  const description = await vscode.window.showInputBox({
    title: vscode.l10n.t("vsCRT: Launch Profile — description (optional)"),
    prompt: vscode.l10n.t("One-line note shown next to the profile."),
  });

  const picks = await vscode.window.showQuickPick(
    allPaths.map((p) => ({ label: p })),
    {
      canPickMany: true,
      title: vscode.l10n.t(
        "vsCRT: Launch Profile — pick servers to include",
      ),
      placeHolder: vscode.l10n.t(
        "Order of selection doesn't matter; run order honours delayMs if set.",
      ),
    },
  );
  if (!picks || picks.length === 0) {return;}

  if (!cfg.launchProfiles) {cfg.launchProfiles = [];}
  const existing = cfg.launchProfiles.map((p) => p.name);
  const finalName = uniqueName(name.trim(), existing);
  const profile: CRTLaunchProfile = {
    name: finalName,
    description: description?.trim() || undefined,
    targets: picks.map((p) => ({ nodePath: p.label })),
  };
  cfg.launchProfiles.push(profile);
  await deps.configManager.saveConfig(cfg);
  vscode.window.showInformationMessage(
    vscode.l10n.t(
      "vsCRT: launch profile '{0}' saved with {1} target(s).",
      finalName,
      picks.length,
    ),
  );
}

async function deleteProfile(deps: CommandDeps): Promise<void> {
  const cfg = await deps.configManager.loadConfig();
  if (!cfg?.launchProfiles || cfg.launchProfiles.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("vsCRT: no launch profiles to delete."),
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    cfg.launchProfiles.map((p) => ({
      label: p.name,
      description: `${p.targets.length} target(s)`,
    })),
    {
      title: vscode.l10n.t("vsCRT: Delete Launch Profile"),
      placeHolder: vscode.l10n.t("Pick a profile to remove."),
    },
  );
  if (!picked) {return;}
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t("Delete launch profile '{0}'?", picked.label),
    { modal: true },
    vscode.l10n.t("Delete"),
  );
  if (confirmed !== vscode.l10n.t("Delete")) {return;}
  cfg.launchProfiles = cfg.launchProfiles.filter(
    (p) => p.name !== picked.label,
  );
  await deps.configManager.saveConfig(cfg);
}

function walkNodesPaths(
  cfg: CRTConfig,
  prefix: string,
  out: string[],
): void {
  const walk = (
    clusters: { name: string; nodes?: { name: string }[]; subfolder?: unknown }[],
    p: string,
  ): void => {
    for (const c of clusters) {
      const here = p ? `${p}/${c.name}` : c.name;
      for (const n of c.nodes ?? []) {
        out.push(`${here}/${n.name}`);
      }
      if (Array.isArray(c.subfolder)) {
        walk(
          c.subfolder as { name: string; nodes?: { name: string }[]; subfolder?: unknown }[],
          here,
        );
      }
    }
  };
  if (Array.isArray(cfg.folder)) {
    walk(
      cfg.folder as unknown as {
        name: string;
        nodes?: { name: string }[];
        subfolder?: unknown;
      }[],
      prefix,
    );
  }
}
