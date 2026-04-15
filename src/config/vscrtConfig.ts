import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { CRTSecretService, SECRET_PREFIX } from "./vscrtSecret";

/* -------------------------------------------------------
 *      DATA STRUCTURES FOR ~/.vscrt/vscrtConfig.json
 * -----------------------------------------------------*/

export interface CRTConfig {
  folder?: CRTConfigCluster[];
  // Optional top-level settings. Config-file values beat VS Code user
  // settings when resolving terminal location (but per-node overrides and
  // the explicit "open in editor" button still win above them).
  "vsCRT.doubleClickTerminalLocation"?: CRTTerminalLocation;
  "vsCRT.buttonClickTerminalLocation"?: CRTTerminalLocation;
}

export interface CRTConfigCluster {
  name: string;
  icon?: string; // codicon name (without the "codicon-" prefix)
  subfolder?: CRTConfigCluster[];
  nodes?: CRTConfigNode[];
}
export type CRTAuthMethod = "password" | "publickey";
export type CRTPasswordDelivery = "argv" | "tempfile" | "pipe";
export type CRTPasswordStorage = "secretstorage" | "passphrase";
export type CRTTerminalLocation = "panel" | "editor";
export interface CRTConfigNode {
  name: string;
  endpoint: string;
  icon?: string; // codicon name (without the "codicon-" prefix)
  hostName?: string;
  user?: string;
  preferredAuthentication?: CRTAuthMethod;
  identityFile?: string;
  extraArgs?: string;
  password?: string; // "@secret:<uuid>", "enc:v3:<...>", or legacy plaintext
  passwordDelivery?: CRTPasswordDelivery;
  passwordStorage?: CRTPasswordStorage; // opt-in: "passphrase" encrypts in-file via Argon2id+AES-GCM
  terminalLocation?: CRTTerminalLocation; // per-node override; wins over user settings
}

/* -------------------------------------------------------
 *      DEFAULT CONFIG HELPER
 * -----------------------------------------------------*/

function createDefaultConfig(): CRTConfig {
  return {
    folder: [
      {
        name: "Production",
        nodes: [{ name: "Prod Web", endpoint: "deploy@prod-web" }],
        subfolder: [
          {
            name: "Database",
            nodes: [{ name: "Prod DB", endpoint: "postgres@prod-db" }],
          },
        ],
      },
      {
        name: "Staging",
        nodes: [{ name: "Staging Web", endpoint: "deploy@staging-web" }],
      },
    ],
  };
}

/* -------------------------------------------------------
 *      SERVICE: LOAD + CREATE ~/.vscrt/vscrtConfig.json
 * -----------------------------------------------------*/

export class CRTConfigService {
  private readonly folderName = ".vscrt";
  private readonly fileName = "vscrtConfig.json";
  private migrationNoticeShown = false;

  constructor(
    private readonly secretService?: CRTSecretService,
    private readonly extensionUri?: vscode.Uri,
  ) {}

  /** Load config (auto-creates folder + file if missing). */
  async loadConfig(): Promise<CRTConfig | undefined> {
    try {
      const uri = await this.ensureConfigFile();
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(buf).toString("utf8").trim();

      if (!text) {
        return {};
      }

      const parsed = (JSON.parse(text) as CRTConfig) || {};
      const renamedKeys = migrateLegacyKeys(parsed);
      const looseMoved = migrateLooseNodes(parsed);
      const portsMerged = migratePortField(parsed);
      const config = parsed;
      const schemaChanged = renamedKeys || looseMoved > 0 || portsMerged;

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
          `vsCRT: moved ${looseMoved} top-level server(s) into the "Unfiled" folder.`,
        );
      }

      return config;
    } catch (err) {
      console.error("[vsCRT] Failed to load vscrtConfig.json:", err);
      return undefined;
    }
  }

  /** Opens config file in VSCode editor. */
  async openConfigFile(): Promise<void> {
    try {
      const uri = await this.ensureConfigFile();
      await vscode.window.showTextDocument(uri);
    } catch (err) {
      vscode.window.showErrorMessage("[vsCRT] Could not open config file.");
      console.error("[vsCRT] openConfigFile error:", err);
    }
  }

  /** Save config object back to ~/.vscrt/vscrtConfig.json */
  async saveConfig(config: CRTConfig): Promise<void> {
    const uri = await this.ensureConfigFile();
    if (this.secretService) {
      await this.sealLegacyPlaintext(config);
    }
    await this.writeFile(uri, config);
    if (this.secretService) {
      await this.secretService.pruneOrphans(collectRefs(config));
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
      console.warn(
        "[vsCRT] appendNode: invalid JSON, starting from empty config",
      );
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
    const added = this.appendNodeToClusterList(
      config.folder,
      targetClusterName,
      node,
    );
    if (!added) {
      console.warn(
        `[vsCRT] appendNode: folder "${targetClusterName}" not found in config.`,
      );
      return false;
    }

    await this.writeFile(uri, config);
    return true;
  }

  private appendNodeToClusterList(
    clusters: CRTConfigCluster[],
    targetName: string,
    node: CRTConfigNode,
  ): boolean {
    for (const c of clusters) {
      if (c.name === targetName) {
        if (!c.nodes) {
          c.nodes = [];
        }
        c.nodes.push(node);
        return true;
      }

      if (
        c.subfolder &&
        this.appendNodeToClusterList(c.subfolder, targetName, node)
      ) {
        return true;
      }
    }
    return false;
  }

  private async ensureConfigFile(): Promise<vscode.Uri> {
    const home = os.homedir();

    const folderPath = path.join(home, this.folderName);
    const folderUri = vscode.Uri.file(folderPath);

    await vscode.workspace.fs.createDirectory(folderUri);

    const filePath = path.join(folderPath, this.fileName);
    const fileUri = vscode.Uri.file(filePath);

    try {
      await vscode.workspace.fs.stat(fileUri);
      return fileUri;
    } catch {
      const buffer = await this.readBundledExample();
      await vscode.workspace.fs.writeFile(fileUri, buffer);

      console.log("[vsCRT] Created new vscrtConfig.json:", filePath);
      return fileUri;
    }
  }

  /**
   * Return the bytes that should seed a brand-new vscrtConfig.json. Prefers
   * the bundled `vscrtConfigExample.json` at the extension root (so users can
   * hand-edit the canonical example). Falls back to the hardcoded default if
   * the file can't be read — e.g. because the extension was packaged without
   * it.
   */
  private async readBundledExample(): Promise<Uint8Array> {
    if (this.extensionUri) {
      const exampleUri = vscode.Uri.joinPath(
        this.extensionUri,
        "vscrtConfigExample.json",
      );
      try {
        return await vscode.workspace.fs.readFile(exampleUri);
      } catch (err) {
        console.warn(
          "[vsCRT] Could not read bundled example config; using built-in default.",
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
    const newText = JSON.stringify(config, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, "utf8"));
  }

  /** Seal any plaintext password fields in-place.  Returns count migrated. */
  private async sealLegacyPlaintext(config: CRTConfig): Promise<number> {
    if (!this.secretService) {
      return 0;
    }
    let count = 0;
    const walkNodes = async (nodes: CRTConfigNode[]): Promise<void> => {
      for (const n of nodes) {
        if (!n.password) {
          continue;
        }
        if (this.secretService!.isLegacyPlaintext(n.password)) {
          const mode =
            n.passwordStorage === "passphrase" ? "passphrase" : "secretstorage";
          n.password = await this.secretService!.seal(n.password, mode);
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
      console.warn(
        "[vsCRT] appendCluster: invalid JSON, starting from empty config",
      );
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
      const added = this.appendClusterToClusterList(
        config.folder,
        parentClusterName,
        newCluster,
      );
      if (!added) {
        console.warn(
          `[vsCRT] appendCluster: parent "${parentClusterName}" not found in config.`,
        );
        return false;
      }
    }

    await this.writeFile(uri, config);
    return true;
  }

  private appendClusterToClusterList(
    clusters: CRTConfigCluster[],
    targetName: string,
    childCluster: CRTConfigCluster,
  ): boolean {
    for (const c of clusters) {
      if (c.name === targetName) {
        if (!c.subfolder) {
          c.subfolder = [];
        }
        c.subfolder.push(childCluster);
        return true;
      }

      if (
        c.subfolder &&
        this.appendClusterToClusterList(c.subfolder, targetName, childCluster)
      ) {
        return true;
      }
    }
    return false;
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
    const cfg = await this.loadConfig();
    if (!cfg) {
      return false;
    }
    const name = oldPath.split("/").pop() ?? oldPath;
    const lastSlash = oldPath.lastIndexOf("/");
    if (lastSlash < 0) {
      // Servers must live inside a folder; a root-level path is invalid.
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
    if (!cfg) {
      return null;
    }
    const cluster = findClusterByPath(cfg, path);
    if (!cluster) {
      return null;
    }
    let nodes = 0;
    let subfolder = 0;
    const walk = (c: CRTConfigCluster): void => {
      nodes += c.nodes?.length ?? 0;
      for (const s of c.subfolder ?? []) {
        subfolder += 1;
        walk(s);
      }
    };
    walk(cluster);
    return { nodes, subfolder };
  }

  /** Return every folder's slash-joined path, depth-first. */
  async getAllFolderPaths(): Promise<string[]> {
    const cfg = await this.loadConfig();
    if (!cfg?.folder) {
      return [];
    }
    const out: string[] = [];
    const walk = (list: CRTConfigCluster[], prefix: string): void => {
      for (const c of list) {
        const p = prefix ? `${prefix}/${c.name}` : c.name;
        out.push(p);
        if (c.subfolder) {
          walk(c.subfolder, p);
        }
      }
    };
    walk(cfg.folder, "");
    return out;
  }

  /** Collect every node under a folder path (direct + nested in subfolders). */
  async getAllNodesInFolder(path: string): Promise<CRTConfigNode[] | null> {
    const cfg = await this.loadConfig();
    if (!cfg) {
      return null;
    }
    const cluster = findClusterByPath(cfg, path);
    if (!cluster) {
      return null;
    }
    const out: CRTConfigNode[] = [];
    const walk = (c: CRTConfigCluster): void => {
      for (const n of c.nodes ?? []) {
        out.push(n);
      }
      for (const s of c.subfolder ?? []) {
        walk(s);
      }
    };
    walk(cluster);
    return out;
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

/* -------------------------------------------------------
 *      HELPERS
 * -----------------------------------------------------*/

/**
 * One-shot rename of legacy JSON keys: { "clusters": [...] } → { "folder": [...] }
 * and nested "subclusters" → "subfolder". Mutates the config in place.
 * Returns true if anything was renamed (caller should persist).
 */
function migrateLegacyKeys(config: CRTConfig): boolean {
  const raw = config as unknown as Record<string, unknown>;
  let changed = false;

  if (Array.isArray(raw.clusters) && !Array.isArray(raw.folder)) {
    raw.folder = raw.clusters;
    delete raw.clusters;
    changed = true;
  }

  const walk = (arr: unknown): void => {
    if (!Array.isArray(arr)) {
      return;
    }
    for (const item of arr) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const node = item as Record<string, unknown>;
      if (Array.isArray(node.subclusters) && !Array.isArray(node.subfolder)) {
        node.subfolder = node.subclusters;
        delete node.subclusters;
        changed = true;
      }
      if (Array.isArray(node.subfolder)) {
        walk(node.subfolder);
      }
    }
  };
  walk(raw.folder);
  return changed;
}

/**
 * Older configs stored the SSH port in a separate `port` field. The schema
 * now folds the port into the endpoint string (e.g. "user@host:2201"). This
 * migration merges any legacy `port` into `endpoint` and drops the field.
 * Mutates the config in place; returns the count of nodes whose endpoint
 * string actually changed.
 */
function migratePortField(config: CRTConfig): boolean {
  let changed = false;
  const hasPortSuffix = /:\d+$/;
  const walkNodes = (nodes: CRTConfigNode[]): void => {
    for (const n of nodes) {
      const raw = n as unknown as Record<string, unknown>;
      const p = raw.port;
      if (typeof p === "number") {
        const ep = typeof n.endpoint === "string" ? n.endpoint.trim() : "";
        if (ep && p !== 22 && !hasPortSuffix.test(ep)) {
          n.endpoint = `${ep}:${p}`;
        }
        delete raw.port;
        changed = true;
      } else if (p !== undefined) {
        delete raw.port;
        changed = true;
      }
    }
  };
  const walkClusters = (cs: CRTConfigCluster[]): void => {
    for (const c of cs) {
      if (c.nodes) {
        walkNodes(c.nodes);
      }
      if (c.subfolder) {
        walkClusters(c.subfolder);
      }
    }
  };
  if (config.folder) {
    walkClusters(config.folder);
  }
  return changed;
}

/**
 * Loose servers at the config root are no longer supported. If any are found
 * (e.g. from an older schema), move them into an "Unfiled" folder so no user
 * data is lost. Mutates the config in place; returns the count migrated.
 */
function migrateLooseNodes(config: CRTConfig): number {
  const raw = config as unknown as Record<string, unknown>;
  const loose = raw.nodes;
  if (!Array.isArray(loose)) {
    return 0;
  }
  if (loose.length === 0) {
    delete raw.nodes;
    return 0;
  }
  config.folder = config.folder ?? [];
  let unfiled = config.folder.find((f) => f.name === "Unfiled");
  if (!unfiled) {
    unfiled = { name: "Unfiled", nodes: [], subfolder: [] };
    config.folder.push(unfiled);
  }
  unfiled.nodes = unfiled.nodes ?? [];
  unfiled.nodes.push(...(loose as CRTConfigNode[]));
  delete raw.nodes;
  return loose.length;
}

function collectRefs(config: CRTConfig): string[] {
  const refs: string[] = [];
  const walkNodes = (nodes: CRTConfigNode[]): void => {
    for (const n of nodes) {
      if (n.password && n.password.startsWith(SECRET_PREFIX)) {
        refs.push(n.password);
      }
    }
  };
  const walkClusters = (clusters: CRTConfigCluster[]): void => {
    for (const c of clusters) {
      if (c.nodes) {
        walkNodes(c.nodes);
      }
      if (c.subfolder) {
        walkClusters(c.subfolder);
      }
    }
  };
  if (config.folder) {
    walkClusters(config.folder);
  }
  return refs;
}

function findNodeByName(
  config: CRTConfig,
  name: string,
): CRTConfigNode | undefined {
  const walkNodes = (nodes: CRTConfigNode[]): CRTConfigNode | undefined =>
    nodes.find((n) => n.name === name);
  const walkClusters = (
    clusters: CRTConfigCluster[],
  ): CRTConfigNode | undefined => {
    for (const c of clusters) {
      if (c.nodes) {
        const hit = walkNodes(c.nodes);
        if (hit) {
          return hit;
        }
      }
      if (c.subfolder) {
        const hit = walkClusters(c.subfolder);
        if (hit) {
          return hit;
        }
      }
    }
    return undefined;
  };
  if (config.folder) {
    const hit = walkClusters(config.folder);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/* -------------------------------------------------------
 *      PATH-BASED HELPERS
 * -----------------------------------------------------*/

function lastSegment(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.substring(i + 1);
}

function parentPathOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i < 0 ? null : path.substring(0, i);
}

/**
 * Return `base` if it doesn't collide with `existing`; otherwise append
 * " 2", " 3", … until unique.
 */
function uniqueName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) {
    return base;
  }
  for (let i = 2; ; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

function isDescendantPath(ancestor: string, candidate: string): boolean {
  return candidate.startsWith(ancestor + "/");
}

function findClusterByPath(
  cfg: CRTConfig,
  path: string,
): CRTConfigCluster | null {
  const segments = path.split("/");
  let list: CRTConfigCluster[] | undefined = cfg.folder;
  let found: CRTConfigCluster | null = null;
  for (const seg of segments) {
    if (!list) {
      return null;
    }
    found = list.find((c) => c.name === seg) ?? null;
    if (!found) {
      return null;
    }
    list = found.subfolder;
  }
  return found;
}

function findNodeByPath(
  cfg: CRTConfig,
  path: string,
): CRTConfigNode | null {
  const name = lastSegment(path);
  const parentP = parentPathOf(path);
  if (parentP === null) {
    return null;
  }
  const parent = findClusterByPath(cfg, parentP);
  return parent?.nodes?.find((n) => n.name === name) ?? null;
}

function findParent(
  cfg: CRTConfig,
  path: string,
): CRTConfig | CRTConfigCluster | null {
  const parentP = parentPathOf(path);
  if (parentP === null) {
    return cfg;
  }
  return findClusterByPath(cfg, parentP);
}

/**
 * Returns the clusters and nodes arrays of a parent container, lazily
 * initializing either if missing. Works for both the root config and a
 * CRTConfigCluster.
 */
function isCluster(
  parent: CRTConfig | CRTConfigCluster,
): parent is CRTConfigCluster {
  return (parent as CRTConfigCluster).name !== undefined;
}

function getContainers(parent: CRTConfig | CRTConfigCluster): {
  clusters: CRTConfigCluster[];
  nodes: CRTConfigNode[];
} {
  if (isCluster(parent)) {
    parent.subfolder = parent.subfolder ?? [];
    parent.nodes = parent.nodes ?? [];
    return { clusters: parent.subfolder, nodes: parent.nodes };
  }
  parent.folder = parent.folder ?? [];
  // Root has no `nodes` container — servers must live inside a folder.
  return { clusters: parent.folder, nodes: [] };
}

function extractNodeByPath(
  cfg: CRTConfig,
  path: string,
): CRTConfigNode | null {
  const name = lastSegment(path);
  const parentP = parentPathOf(path);
  if (parentP === null) {
    return null;
  }
  const parent = findClusterByPath(cfg, parentP);
  if (!parent || !parent.nodes) {
    return null;
  }
  const idx = parent.nodes.findIndex((n) => n.name === name);
  if (idx < 0) {
    return null;
  }
  return parent.nodes.splice(idx, 1)[0];
}

function extractClusterByPath(
  cfg: CRTConfig,
  path: string,
): CRTConfigCluster | null {
  const name = lastSegment(path);
  const parentP = parentPathOf(path);

  if (parentP === null) {
    const arr = cfg.folder;
    if (!arr) {
      return null;
    }
    const idx = arr.findIndex((c) => c.name === name);
    if (idx < 0) {
      return null;
    }
    return arr.splice(idx, 1)[0];
  }

  const parent = findClusterByPath(cfg, parentP);
  if (!parent || !parent.subfolder) {
    return null;
  }
  const idx = parent.subfolder.findIndex((c) => c.name === name);
  if (idx < 0) {
    return null;
  }
  return parent.subfolder.splice(idx, 1)[0];
}
