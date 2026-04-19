import * as os from "os";
import * as vscode from "vscode";
import * as vscrtPaths from "../fsPaths";
import { log } from "../log";
import { CRTSecretService } from "./vscrtSecret";
import { createAndRotateBackup } from "./vscrtConfigBackup";
import {
  isSharedPath,
  mergeSharedIntoConfig,
  readSharedConfigFile,
  resolveSharedConfigPath,
  stripSharedFolder,
} from "./sharedConfig";
import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
  createDefaultConfig,
} from "./vscrtConfigTypes";
import {
  collectRefs,
  migrateLegacyKeys,
  migrateLooseNodes,
  migratePortField,
} from "./vscrtConfigMigrations";
import {
  CURRENT_SCHEMA_VERSION,
  runMigrations,
} from "./vscrtConfigSchemaVersion";
import {
  extractClusterByPath,
  extractNodeByPath,
  findClusterByPath,
  findNodeByName,
  findNodeByPath,
  findParent,
  getContainers,
  isCluster,
  isDescendantPath,
  lastSegment,
  parentPathOf,
  uniqueName,
} from "./vscrtConfigPaths";
import {
  appendClusterToCluster,
  appendNodeToCluster,
  countClusterContents,
  listAllFolderPaths,
  listAllNodesInFolder,
} from "./vscrtConfigUtil";

/**
 * Re-exports so the historical surface (types + previously-exported helpers
 * used by tests and by modules that import `"./vscrtConfig"`) keeps working.
 */
export {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
  CRTAuthMethod,
  CRTLaunchProfile,
  CRTLaunchTarget,
  CRTNodeCommand,
  CRTPasswordDelivery,
  CRTPasswordStorage,
  CRTTerminalLocation,
} from "./vscrtConfigTypes";
export {
  migrateLegacyKeys,
  migrateLooseNodes,
  migratePortField,
} from "./vscrtConfigMigrations";
export { isDescendantPath, uniqueName } from "./vscrtConfigPaths";

/* -------------------------------------------------------
 *      SERVICE: LOAD + CREATE ~/.vscrt/vscrtConfig.json
 * -----------------------------------------------------*/

export class CRTConfigService {
  private migrationNoticeShown = false;

  /**
   * In-memory cache of the parsed config. Populated on first successful
   * `loadConfig()` and kept in sync by `writeFile` on every disk write.
   * Cleared by `invalidateCache()` — typically invoked by the file-system
   * watcher set up in `activate()` when the user edits vscrtConfig.json
   * externally.
   */
  private cachedConfig: CRTConfig | undefined;
  /**
   * In-flight `loadConfig` promise. Dedups concurrent callers (common
   * during activation when both views query the config at the same time)
   * so migrations and orphan pruning only run once per cold read.
   */
  private cachedLoadPromise: Promise<CRTConfig | undefined> | undefined;
  /**
   * Suppresses repeat recovery modals when the config stays broken across
   * back-to-back loads (every tree refresh, every status tick). Cleared
   * alongside the cache in `invalidateCache()` so a fresh external edit
   * re-arms the prompt.
   */
  private recoveryPromptShown = false;

  constructor(
    private readonly secretService?: CRTSecretService,
    private readonly extensionUri?: vscode.Uri,
  ) {}

  /**
   * Load config (auto-creates folder + file if missing). Returns the cached
   * reference when available; otherwise parses from disk, runs migrations,
   * and populates the cache.
   *
   * Callers may mutate the returned object — they must call `saveConfig` to
   * persist. `writeFile` updates the cache on every successful disk write,
   * so the cache stays consistent as long as every path ends in a save.
   */
  async loadConfig(): Promise<CRTConfig | undefined> {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }
    if (!this.cachedLoadPromise) {
      this.cachedLoadPromise = log
        .timed("loadConfig", () => this.loadConfigFromDisk(), { slowMs: 150 })
        .finally(() => {
          this.cachedLoadPromise = undefined;
        });
    }
    return this.cachedLoadPromise;
  }

  /** Drop the cached config + any in-flight load. Next `loadConfig` re-reads disk. */
  invalidateCache(): void {
    this.cachedConfig = undefined;
    this.cachedLoadPromise = undefined;
    this.recoveryPromptShown = false;
  }

  private async loadConfigFromDisk(): Promise<CRTConfig | undefined> {
    try {
      const uri = await this.ensureConfigFile();
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(buf).toString("utf8").trim();

      if (!text) {
        const empty: CRTConfig = {};
        this.cachedConfig = empty;
        return empty;
      }

      let parsed: CRTConfig;
      try {
        parsed = (JSON.parse(text) as CRTConfig) || {};
      } catch (parseErr) {
        log.error(
          "vscrtConfig.json is not valid JSON — skipping load:",
          parseErr,
        );
        this.showRecoveryPrompt(parseErr);
        return undefined;
      }
      // First: check schema version. Forward-incompat files don't get
      // migrations run on them — that would silently destroy fields a
      // newer install knew how to read. Instead, surface the recovery
      // modal and return undefined.
      const versionResult = runMigrations(parsed);
      if (versionResult.forwardIncompatible) {
        log.error(
          `vscrtConfig.json $schemaVersion=${versionResult.from} is newer than this extension supports (${CURRENT_SCHEMA_VERSION}). Refusing to migrate down.`,
        );
        this.showRecoveryPrompt(
          new Error(
            `Config was written by a newer vsCRT ($schemaVersion ${versionResult.from}). Install a newer extension or restore from a backup.`,
          ),
        );
        return undefined;
      }
      // Always re-run the individual heuristic migrations too — they
      // catch partial legacy state that wouldn't be stamped by a
      // version bump alone. `runMigrations` does the same work but
      // stamps `$schemaVersion`; duplicated calls are no-ops because
      // each migration self-gates.
      const renamedKeys = migrateLegacyKeys(parsed);
      const looseMoved = migrateLooseNodes(parsed);
      const portsMerged = migratePortField(parsed);
      const config = parsed;
      const schemaChanged =
        versionResult.changed ||
        renamedKeys ||
        looseMoved > 0 ||
        portsMerged;

      if (this.secretService) {
        const migrated = await this.sealLegacyPlaintext(config);
        if (migrated > 0 || schemaChanged) {
          await this.writeFile(uri, config);
        }
        if (migrated > 0) {
          this.announceMigration(migrated);
        }
        await this.secretService.pruneOrphans(collectRefs(config));
      } else if (schemaChanged) {
        await this.writeFile(uri, config);
      }

      if (looseMoved > 0) {
        vscode.window.showInformationMessage(
          `vsCRT: moved ${looseMoved} top-level ${looseMoved === 1 ? "server" : "servers"} into the "Unfiled" folder.`,
        );
      }

      // Merge in any team-shared configs. Gated on workspace trust so
      // an attacker planting a shared-config path + file into an
      // untrusted clone can't pull servers into the tree.
      const merged = await this.applySharedOverlay(config);
      this.cachedConfig = merged;
      return merged;
    } catch (err) {
      log.error("Failed to load vscrtConfig.json:", err);
      return undefined;
    }
  }

  /**
   * Read `vsCRT.sharedConfigPaths`, load + sanitize each file, and
   * append the synthetic "Shared (read-only)" folder to the returned
   * config. Untrusted workspaces, empty settings, and parse-failure
   * cases all no-op.
   *
   * Exported via this method (not a free function) because we need the
   * VS Code workspace APIs.
   */
  private async applySharedOverlay(config: CRTConfig): Promise<CRTConfig> {
    if (!vscode.workspace.isTrusted) {
      return config;
    }
    const rawPaths = vscode.workspace
      .getConfiguration("vsCRT")
      .get<string[]>("sharedConfigPaths");
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      return config;
    }
    const homeDir = os.homedir();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const clustersPerFile = await Promise.all(
      rawPaths
        .filter((p): p is string => typeof p === "string" && p.trim() !== "")
        .map((raw) => {
          const expanded = workspaceFolder
            ? raw.replace(/\$\{workspaceFolder\}/g, workspaceFolder)
            : raw;
          const resolved = resolveSharedConfigPath(expanded, homeDir);
          return readSharedConfigFile(resolved, (err) => {
            log.warn(`shared config: failed to load ${resolved}:`, err);
          });
        }),
    );
    return mergeSharedIntoConfig(config, clustersPerFile);
  }

  /** Opens config file in VSCode editor. */
  async openConfigFile(): Promise<void> {
    try {
      const uri = await this.ensureConfigFile();
      await vscode.window.showTextDocument(uri);
    } catch (err) {
      vscode.window.showErrorMessage("[vsCRT] Could not open config file.");
      log.error("openConfigFile error:", err);
    }
  }

  /** Save config object back to ~/.vscrt/vscrtConfig.json */
  async saveConfig(config: CRTConfig): Promise<void> {
    // Shared overlay MUST NEVER round-trip into the personal config
    // file. Strip it before everything else so seal/prune operate on
    // the real user tree only.
    const toWrite = stripSharedFolder(config);
    const uri = await this.ensureConfigFile();
    if (this.secretService) {
      await this.sealLegacyPlaintext(toWrite);
    }
    await this.writeFile(uri, toWrite);
    if (this.secretService) {
      await this.secretService.pruneOrphans(collectRefs(toWrite));
    }
  }

  /**
   * Switch a node between SecretStorage and passphrase-encrypted in-file storage.
   * Re-seals the current password under the new mode (requires unsealing first).
   */
  async setPasswordStorage(
    nodeName: string,
    mode: "secretstorage" | "passphrase",
  ): Promise<boolean> {
    if (!this.secretService) {
      return false;
    }
    const config = await this.loadConfig();
    if (!config) {
      return false;
    }
    const node = findNodeByName(config, nodeName);
    if (!node) {
      return false;
    }

    if ((node.passwordStorage ?? "secretstorage") === mode && node.password) {
      return true;
    }

    if (node.password) {
      const plaintext = await this.secretService.unseal(node.password);
      if (plaintext === undefined) {
        return false;
      }
      await this.secretService.forget(node.password);
      node.password = await this.secretService.seal(plaintext, mode);
    }

    if (mode === "secretstorage") {
      delete node.passwordStorage;
    } else {
      node.passwordStorage = mode;
    }

    const uri = await this.ensureConfigFile();
    await this.writeFile(uri, config);
    return true;
  }

  /** Change a node's password. Looks up by unique node name. */
  async updatePassword(nodeName: string, newPlaintext: string): Promise<boolean> {
    if (!this.secretService) {
      return false;
    }
    const config = await this.loadConfig();
    if (!config) {
      return false;
    }
    const node = findNodeByName(config, nodeName);
    if (!node) {
      return false;
    }
    await this.secretService.forget(node.password);
    node.password = await this.secretService.seal(
      newPlaintext,
      node.passwordStorage === "passphrase" ? "passphrase" : "secretstorage",
    );
    if (!node.preferredAuthentication) {
      node.preferredAuthentication = "password";
    }
    const uri = await this.ensureConfigFile();
    await this.writeFile(uri, config);
    return true;
  }

  /** Append a node to a folder (by name). Servers cannot live at the root. */
  async appendNode(
    targetClusterName: string,
    node: CRTConfigNode,
  ): Promise<boolean> {
    if (!targetClusterName) {
      return false;
    }

    const uri = await this.ensureConfigFile();
    const buf = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(buf).toString("utf8").trim();

    let config: CRTConfig;
    try {
      config = text ? (JSON.parse(text) as CRTConfig) || {} : {};
    } catch {
      log.warn("appendNode: invalid JSON, starting from empty config");
      config = {};
    }

    if (this.secretService && node.password) {
      if (this.secretService.isLegacyPlaintext(node.password)) {
        node.password = await this.secretService.seal(
          node.password,
          node.passwordStorage === "passphrase" ? "passphrase" : "secretstorage",
        );
      }
    }

    if (!config.folder) {
      config.folder = [];
    }
    const added = appendNodeToCluster(
      config.folder,
      targetClusterName,
      node,
    );
    if (!added) {
      log.warn(
        `appendNode: folder "${targetClusterName}" not found in config.`,
      );
      return false;
    }

    await this.writeFile(uri, config);
    return true;
  }

  private async ensureConfigFile(): Promise<vscode.Uri> {
    const folderUri = vscode.Uri.file(vscrtPaths.vscrtHomeDir());

    await vscode.workspace.fs.createDirectory(folderUri);

    const filePath = vscrtPaths.vscrtConfigFilePath();
    const fileUri = vscode.Uri.file(filePath);

    try {
      await vscode.workspace.fs.stat(fileUri);
      return fileUri;
    } catch {
      // First-run: seed with an empty `{"folder": []}` so the user sees
      // the welcome walkthrough + empty-state. A rich example is
      // available opt-in via the "Load Example" button in the empty
      // state (→ `vsCRT.loadExample`).
      const buffer = Buffer.from(
        JSON.stringify(createDefaultConfig(), null, 2),
        "utf8",
      );
      await vscode.workspace.fs.writeFile(fileUri, buffer);

      log.info("Created new vscrtConfig.json:", filePath);
      return fileUri;
    }
  }

  /**
   * Read the bundled `vscrtConfigExample.json` file (shipped at the
   * extension root) and return its raw bytes. Used by the "Load
   * Example" flow so users can opt in to a populated demo tree from
   * the Connection view's empty-state.
   */
  async readBundledExample(): Promise<Uint8Array> {
    if (this.extensionUri) {
      const exampleUri = vscode.Uri.joinPath(
        this.extensionUri,
        "vscrtConfigExample.json",
      );
      try {
        return await vscode.workspace.fs.readFile(exampleUri);
      } catch (err) {
        log.warn(
          "Could not read bundled example config; using built-in default.",
          err,
        );
      }
    }
    return Buffer.from(
      JSON.stringify(createDefaultConfig(), null, 2),
      "utf8",
    );
  }

  private async writeFile(uri: vscode.Uri, config: CRTConfig): Promise<void> {
    // Snapshot the prior on-disk file before overwriting. If this is the
    // first-ever save there's nothing to back up and createAndRotateBackup
    // returns null silently. Failures here MUST NOT block the save — a
    // crashed backup is better than a lost user edit — so they're logged
    // and swallowed.
    try {
      const backupsDir = vscrtPaths.vscrtBackupsDir();
      const backupPath = await createAndRotateBackup(uri.fsPath, backupsDir);
      if (backupPath) {
        log.debug(`Backed up vscrtConfig.json to ${backupPath}`);
      }
    } catch (err) {
      log.warn("Backup before save failed (save will still proceed):", err);
    }

    const newText = JSON.stringify(config, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, "utf8"));
    // Keep cache in sync with disk on every write path (saveConfig,
    // appendNode, appendCluster, updatePassword, setPasswordStorage, and
    // the migration-on-load branch in loadConfigFromDisk all route here).
    this.cachedConfig = config;
  }

  /** Seal any plaintext password fields in-place.  Returns count migrated. */
  private async sealLegacyPlaintext(config: CRTConfig): Promise<number> {
    const secrets = this.secretService;
    if (!secrets) {
      return 0;
    }
    let count = 0;
    const walkNodes = async (nodes: CRTConfigNode[]): Promise<void> => {
      for (const n of nodes) {
        if (!n.password) {
          continue;
        }
        if (secrets.isLegacyPlaintext(n.password)) {
          const mode =
            n.passwordStorage === "passphrase" ? "passphrase" : "secretstorage";
          n.password = await secrets.seal(n.password, mode);
          count += 1;
        }
      }
    };
    const walkClusters = async (
      clusters: CRTConfigCluster[],
    ): Promise<void> => {
      for (const c of clusters) {
        if (c.nodes) {
          await walkNodes(c.nodes);
        }
        if (c.subfolder) {
          await walkClusters(c.subfolder);
        }
      }
    };
    if (config.folder) {
      await walkClusters(config.folder);
    }
    return count;
  }

  /**
   * Non-blocking recovery modal fired when vscrtConfig.json fails to parse.
   * Offers three escapes: open the file in the editor, restore from a rolling
   * backup, or reset to an empty config. Each option delegates to a
   * dedicated command so the logic stays in one place and is testable on
   * its own. Suppressed after the first firing per cache cycle — the watcher
   * clears that latch on the next external edit.
   */
  private showRecoveryPrompt(err: unknown): void {
    if (this.recoveryPromptShown) {
      return;
    }
    this.recoveryPromptShown = true;
    const openConfig = "Open Config";
    const restore = "Restore from Backup…";
    const detail =
      err instanceof Error
        ? err.message
        : "The file could not be parsed as JSON.";
    void vscode.window
      .showErrorMessage(
        "vsCRT: vscrtConfig.json is corrupted or not valid JSON. Your server list is temporarily unavailable.",
        { modal: true, detail },
        openConfig,
        restore,
      )
      .then((pick) => {
        if (pick === openConfig) {
          void vscode.commands.executeCommand("vsCRT.openConfig");
        } else if (pick === restore) {
          void vscode.commands.executeCommand("vsCRT.restoreConfigBackup");
        }
      });
  }

  private announceMigration(count: number): void {
    if (this.migrationNoticeShown) {
      return;
    }
    this.migrationNoticeShown = true;
    vscode.window.showInformationMessage(
      `vsCRT: Migrated ${count} plaintext password(s) from vscrtConfig.json into secure storage.`,
    );
  }

  /**
   * Append a new cluster or subcluster
   * - parentClusterName === null  → new root cluster
   * - otherwise                   → new subcluster under that cluster/subcluster
   */
  async appendCluster(
    parentClusterName: string | null,
    clusterName: string,
  ): Promise<boolean> {
    const uri = await this.ensureConfigFile();
    const buf = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(buf).toString("utf8").trim();

    let config: CRTConfig;
    try {
      config = text ? (JSON.parse(text) as CRTConfig) || {} : {};
    } catch {
      log.warn("appendCluster: invalid JSON, starting from empty config");
      config = {};
    }

    const newCluster: CRTConfigCluster = {
      name: clusterName,
      subfolder: [],
      nodes: [],
    };

    if (!parentClusterName) {
      if (!config.folder) {
        config.folder = [];
      }
      config.folder.push(newCluster);
    } else {
      if (!config.folder) {
        config.folder = [];
      }
      const added = appendClusterToCluster(
        config.folder,
        parentClusterName,
        newCluster,
      );
      if (!added) {
        log.warn(
          `appendCluster: parent "${parentClusterName}" not found in config.`,
        );
        return false;
      }
    }

    await this.writeFile(uri, config);
    return true;
  }

  /* -------------------------------------------------------
   *   PATH-BASED LOOKUPS & MOVE OPERATIONS (for drag-drop)
   * ----------------------------------------------------- */

  /**
   * Rename the cluster/subcluster at `path`. Refuses empty names, names
   * containing `/`, or a duplicate-name collision with a sibling at the same
   * level. Returns false if the cluster isn't found or the rename is invalid.
   */
  async renameCluster(path: string, newName: string): Promise<boolean> {
    if (isSharedPath(path)) {
      return false;
    }
    const trimmed = newName.trim();
    if (!trimmed || trimmed.includes("/")) {
      return false;
    }

    const cfg = await this.loadConfig();
    if (!cfg) {
      return false;
    }

    const cluster = findClusterByPath(cfg, path);
    if (!cluster) {
      return false;
    }
    if (cluster.name === trimmed) {
      return true; // no-op
    }

    const lastSlash = path.lastIndexOf("/");
    const parentPath = lastSlash < 0 ? null : path.substring(0, lastSlash);
    const siblings =
      parentPath === null
        ? (cfg.folder ?? [])
        : (findClusterByPath(cfg, parentPath)?.subfolder ?? []);

    if (siblings.some((c) => c !== cluster && c.name === trimmed)) {
      return false; // name collision with another sibling
    }

    cluster.name = trimmed;
    await this.saveConfig(cfg);
    return true;
  }

  /**
   * Replace the node at `oldPath` with `newNode`, keeping its position in the
   * parent's `nodes` array. Used by the edit-server flow after the handler
   * has taken care of password sealing/re-sealing. Returns false if the node
   * can't be found.
   */
  async updateNode(
    oldPath: string,
    newNode: CRTConfigNode,
  ): Promise<boolean> {
    if (isSharedPath(oldPath)) {
      return false;
    }
    const cfg = await this.loadConfig();
    if (!cfg) {
      return false;
    }
    const name = oldPath.split("/").pop() ?? oldPath;
    const lastSlash = oldPath.lastIndexOf("/");
    if (lastSlash < 0) {
      return false;
    }
    const parent = findClusterByPath(cfg, oldPath.substring(0, lastSlash));
    const arr = parent?.nodes;
    if (!arr) {
      return false;
    }
    const idx = arr.findIndex((n) => n.name === name);
    if (idx < 0) {
      return false;
    }
    arr[idx] = newNode;
    await this.saveConfig(cfg);
    return true;
  }

  /**
   * Duplicate the node at `path` — inserts a clone right after the original
   * under the same parent, with a non-colliding "(copy)" name. A SecretStorage
   * password reference is re-sealed so the duplicate owns its own keychain
   * entry (independent from the original). Passphrase-encrypted ciphertext is
   * safe to copy verbatim. Returns the new node's name, or null if the source
   * isn't found.
   */
  async duplicateNode(path: string): Promise<string | null> {
    if (isSharedPath(path)) {
      return null;
    }
    const cfg = await this.loadConfig();
    if (!cfg) {
      return null;
    }
    const source = findNodeByPath(cfg, path);
    if (!source) {
      return null;
    }
    const name = lastSegment(path);
    const parentP = parentPathOf(path);
    if (parentP === null) {
      return null;
    }
    const siblings = findClusterByPath(cfg, parentP)?.nodes;
    if (!siblings) {
      return null;
    }
    const idx = siblings.findIndex((n) => n.name === name);
    if (idx < 0) {
      return null;
    }

    const clone: CRTConfigNode = JSON.parse(JSON.stringify(source));
    clone.name = uniqueName(
      `${source.name} (copy)`,
      siblings.map((n) => n.name),
    );

    if (this.secretService && clone.password && this.secretService.isReference(clone.password)) {
      const plaintext = await this.secretService.unseal(clone.password);
      if (plaintext !== undefined) {
        clone.password = await this.secretService.seal(plaintext, "secretstorage");
      } else {
        delete clone.password;
      }
    }

    siblings.splice(idx + 1, 0, clone);
    await this.saveConfig(cfg);
    return clone.name;
  }

  /** Remove the node at `path`. Returns false if not found. */
  async deleteNode(path: string): Promise<boolean> {
    if (isSharedPath(path)) {
      return false;
    }
    const cfg = await this.loadConfig();
    if (!cfg) {
      return false;
    }
    const removed = extractNodeByPath(cfg, path);
    if (!removed) {
      return false;
    }
    await this.saveConfig(cfg);
    return true;
  }

  /**
   * Remove the cluster/subcluster at `path` along with any nested nodes and
   * subclusters. Password secrets owned by removed nodes are pruned via
   * saveConfig's orphan sweep. Returns false if not found.
   */
  async deleteCluster(path: string): Promise<boolean> {
    if (isSharedPath(path)) {
      return false;
    }
    const cfg = await this.loadConfig();
    if (!cfg) {
      return false;
    }
    const removed = extractClusterByPath(cfg, path);
    if (!removed) {
      return false;
    }
    await this.saveConfig(cfg);
    return true;
  }

  /** Count direct + nested nodes and subclusters under a cluster path (for confirmation UX). */
  async countClusterContents(
    path: string,
  ): Promise<{ nodes: number; subfolder: number } | null> {
    const cfg = await this.loadConfig();
    return cfg ? countClusterContents(cfg, path) : null;
  }

  /** Return every folder's slash-joined path, depth-first. */
  async getAllFolderPaths(): Promise<string[]> {
    const cfg = await this.loadConfig();
    return cfg ? listAllFolderPaths(cfg) : [];
  }

  /** Collect every node under a folder path (direct + nested in subfolders). */
  async getAllNodesInFolder(path: string): Promise<CRTConfigNode[] | null> {
    const cfg = await this.loadConfig();
    return cfg ? listAllNodesInFolder(cfg, path) : null;
  }

  /** Resolve a node by slash-joined path (e.g. "Production/Database/Prod DB"). */
  async getNodeByPath(nodePath: string): Promise<CRTConfigNode | null> {
    const cfg = await this.loadConfig();
    if (!cfg) {
      return null;
    }
    return findNodeByPath(cfg, nodePath);
  }

  /**
   * Set or clear the codicon-name override for a cluster, subcluster, or node.
   * Passing undefined clears the override so the default icon-per-kind applies.
   */
  async setIcon(
    itemPath: string,
    kind: "cluster" | "subcluster" | "node",
    icon: string | undefined,
  ): Promise<boolean> {
    if (isSharedPath(itemPath)) {
      return false;
    }
    const cfg = await this.loadConfig();
    if (!cfg) {
      return false;
    }

    if (kind === "node") {
      const node = findNodeByPath(cfg, itemPath);
      if (!node) {
        return false;
      }
      if (icon) {
        node.icon = icon;
      } else {
        delete node.icon;
      }
    } else {
      const cluster = findClusterByPath(cfg, itemPath);
      if (!cluster) {
        return false;
      }
      if (icon) {
        cluster.icon = icon;
      } else {
        delete cluster.icon;
      }
    }

    await this.saveConfig(cfg);
    return true;
  }

  /**
   * Move a node to a new location. `targetPath` undefined = root. `position`
   * is "inside" (only on cluster/subcluster targets), "before" or "after"
   * (reorder/insert relative to a sibling).
   */
  async moveNode(
    sourcePath: string,
    targetPath: string | undefined,
    targetKind: "cluster" | "subcluster" | "node" | undefined,
    position: "before" | "after" | "inside",
  ): Promise<boolean> {
    // Block drag-drop in or out of the shared overlay — it isn't
    // writable, and a drop-out would silently lose the entry.
    if (isSharedPath(sourcePath) || isSharedPath(targetPath)) {
      return false;
    }
    const cfg = await this.loadConfig();
    if (!cfg) {
      return false;
    }

    const node = extractNodeByPath(cfg, sourcePath);
    if (!node) {
      return false;
    }

    // Servers must live inside a folder; reject drops to the tree root.
    if (!targetPath) {
      return false;
    }

    if (position === "inside") {
      if (targetKind !== "cluster" && targetKind !== "subcluster") {
        return false;
      }
      const cluster = findClusterByPath(cfg, targetPath);
      if (!cluster) {
        return false;
      }
      cluster.nodes = cluster.nodes ?? [];
      cluster.nodes.push(node);
      await this.saveConfig(cfg);
      return true;
    }

    // before / after — insert into target's parent's `nodes` array
    const parent = findParent(cfg, targetPath);
    if (!parent || !isCluster(parent)) {
      // Reject before/after a root-level folder — servers cannot live at root.
      return false;
    }
    const { nodes } = getContainers(parent);

    if (targetKind === "node") {
      const targetName = lastSegment(targetPath);
      const idx = nodes.findIndex((n) => n.name === targetName);
      if (idx < 0) {
        nodes.push(node);
      } else {
        nodes.splice(position === "before" ? idx : idx + 1, 0, node);
      }
    } else {
      // Cross-kind before/after on a cluster target — append to parent.nodes
      // since nodes always render after clusters anyway.
      nodes.push(node);
    }

    await this.saveConfig(cfg);
    return true;
  }

  /**
   * Move a cluster/subcluster to a new location. Rejects cycles (dropping a
   * cluster onto its own descendant).
   */
  async moveCluster(
    sourcePath: string,
    targetPath: string | undefined,
    targetKind: "cluster" | "subcluster" | "node" | undefined,
    position: "before" | "after" | "inside",
  ): Promise<boolean> {
    // Cycle check first (before mutation).
    if (targetPath && isDescendantPath(sourcePath, targetPath)) {
      return false;
    }
    if (targetPath && targetPath === sourcePath) {
      return false;
    }
    // Block moves into/out of the shared overlay.
    if (isSharedPath(sourcePath) || isSharedPath(targetPath)) {
      return false;
    }

    const cfg = await this.loadConfig();
    if (!cfg) {
      return false;
    }

    const cluster = extractClusterByPath(cfg, sourcePath);
    if (!cluster) {
      return false;
    }

    // Root drop
    if (!targetPath) {
      cfg.folder = cfg.folder ?? [];
      cfg.folder.push(cluster);
      await this.saveConfig(cfg);
      return true;
    }

    if (position === "inside") {
      if (targetKind !== "cluster" && targetKind !== "subcluster") {
        return false;
      }
      const parentCluster = findClusterByPath(cfg, targetPath);
      if (!parentCluster) {
        return false;
      }
      parentCluster.subfolder = parentCluster.subfolder ?? [];
      parentCluster.subfolder.push(cluster);
      await this.saveConfig(cfg);
      return true;
    }

    const parent = findParent(cfg, targetPath);
    if (!parent) {
      return false;
    }
    const { clusters } = getContainers(parent);

    if (targetKind === "cluster" || targetKind === "subcluster") {
      const targetName = lastSegment(targetPath);
      const idx = clusters.findIndex((c) => c.name === targetName);
      if (idx < 0) {
        clusters.push(cluster);
      } else {
        clusters.splice(position === "before" ? idx : idx + 1, 0, cluster);
      }
    } else {
      // Cross-kind on a node target — append to parent.folder.
      clusters.push(cluster);
    }

    await this.saveConfig(cfg);
    return true;
  }
}
