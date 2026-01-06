import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";

/* -------------------------------------------------------
 *      DATA STRUCTURES FOR ~/.vsCRT/configSSH.json
 * -----------------------------------------------------*/

export interface CRTConfig {
  clusters?: CRTConfigCluster[];
  nodes?: CRTConfigNode[];
}

export interface CRTConfigCluster {
  name: string;
  subclusters?: CRTConfigCluster[];
  nodes?: CRTConfigNode[];
}
export type CRTAuthMethod = "password" | "publickey";
export interface CRTConfigNode {
  name: string;
  endpoint: string;
  hostName?: string;
  user?: string;
  port?: number;
  preferredAuthentication?: CRTAuthMethod; // ✅ new
  identityFile?: string;
  extraArgs?: string; // e.g. "-L 8080:localhost:80"
  password?: string; // ⚠ optional, plain-text in json file
}

/* -------------------------------------------------------
 *      DEFAULT CONFIG HELPER
 * -----------------------------------------------------*/

function createDefaultConfig(): CRTConfig {
  return {
    clusters: [
      {
        name: "Production",
        nodes: [{ name: "Prod Web", endpoint: "deploy@prod-web" }],
        subclusters: [
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
    nodes: [{ name: "Loose Node", endpoint: "root@192.168.0.10" }],
  };
}

/* -------------------------------------------------------
 *      SERVICE: LOAD + CREATE ~/.vsCRT/configSSH.json
 * -----------------------------------------------------*/

export class CRTConfigService {
  private readonly folderName = ".vsCRT";
  private readonly fileName = "configSSH.json";

  /** Load config (auto-creates folder + file if missing). */
  async loadConfig(): Promise<CRTConfig | undefined> {
    try {
      const uri = await this.ensureConfigFile();
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(buf).toString("utf8").trim();

      if (!text) {
        // Empty file → treat as empty config (no crash)
        return {};
      }

      return (JSON.parse(text) as CRTConfig) || {};
    } catch (err) {
      console.error("[vsCRT] Failed to load configSSH.json:", err);
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

  /**
   * Append a node to:
   *  - a specific cluster / subcluster (by name), OR
   *  - root-level (if targetClusterName == null)
   */
  async appendNode(
    targetClusterName: string | null,
    node: CRTConfigNode
  ): Promise<boolean> {
    const uri = await this.ensureConfigFile();
    const buf = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(buf).toString("utf8").trim();

    let config: CRTConfig;
    try {
      config = text ? (JSON.parse(text) as CRTConfig) || {} : {};
    } catch {
      console.warn(
        "[vsCRT] appendNode: invalid JSON, starting from empty config"
      );
      config = {};
    }

    if (!targetClusterName) {
      // root-level node
      if (!config.nodes) {
        config.nodes = [];
      }
      config.nodes.push(node);
    } else {
      if (!config.clusters) {
        config.clusters = [];
      }
      const added = this.appendNodeToClusterList(
        config.clusters,
        targetClusterName,
        node
      );
      if (!added) {
        console.warn(
          `[vsCRT] appendNode: cluster "${targetClusterName}" not found in config.`
        );
        return false;
      }
    }

    const newText = JSON.stringify(config, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, "utf8"));
    return true;
  }

  /** Recursive helper to find a cluster/subcluster by name and append node */
  private appendNodeToClusterList(
    clusters: CRTConfigCluster[],
    targetName: string,
    node: CRTConfigNode
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
        c.subclusters &&
        this.appendNodeToClusterList(c.subclusters, targetName, node)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Ensure ~/.vsCRT and configSSH.json exist (creates default if missing). */
  private async ensureConfigFile(): Promise<vscode.Uri> {
    const home = os.homedir();

    const folderPath = path.join(home, this.folderName);
    const folderUri = vscode.Uri.file(folderPath);

    // Always create folder (no error if exists)
    await vscode.workspace.fs.createDirectory(folderUri);

    const filePath = path.join(folderPath, this.fileName);
    const fileUri = vscode.Uri.file(filePath);

    // If file exists → just return it (we handle empty/invalid elsewhere)
    try {
      await vscode.workspace.fs.stat(fileUri);
      return fileUri;
    } catch {
      // Missing → write default config
      const defaultConfig = createDefaultConfig();

      const buffer = Buffer.from(
        JSON.stringify(defaultConfig, null, 2),
        "utf8"
      );
      await vscode.workspace.fs.writeFile(fileUri, buffer);

      console.log("[vsCRT] Created new configSSH.json:", filePath);
      return fileUri;
    }
  }

  /**
   * Append a new cluster or subcluster
   * - parentClusterName === null  → new root cluster
   * - otherwise                   → new subcluster under that cluster/subcluster
   */
  async appendCluster(
    parentClusterName: string | null,
    clusterName: string
  ): Promise<boolean> {
    const uri = await this.ensureConfigFile();
    const buf = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(buf).toString("utf8").trim();

    let config: CRTConfig;
    try {
      config = text ? (JSON.parse(text) as CRTConfig) || {} : {};
    } catch {
      console.warn(
        "[vsCRT] appendCluster: invalid JSON, starting from empty config"
      );
      config = {};
    }

    const newCluster: CRTConfigCluster = {
      name: clusterName,
      subclusters: [],
      nodes: [],
    };

    if (!parentClusterName) {
      // root-level cluster
      if (!config.clusters) {
        config.clusters = [];
      }
      config.clusters.push(newCluster);
    } else {
      if (!config.clusters) {
        config.clusters = [];
      }
      const added = this.appendClusterToClusterList(
        config.clusters,
        parentClusterName,
        newCluster
      );
      if (!added) {
        console.warn(
          `[vsCRT] appendCluster: parent "${parentClusterName}" not found in config.`
        );
        return false;
      }
    }

    const newText = JSON.stringify(config, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, "utf8"));
    return true;
  }

  /** Recursive helper to add a subcluster under a given cluster name */
  private appendClusterToClusterList(
    clusters: CRTConfigCluster[],
    targetName: string,
    childCluster: CRTConfigCluster
  ): boolean {
    for (const c of clusters) {
      if (c.name === targetName) {
        if (!c.subclusters) {
          c.subclusters = [];
        }
        c.subclusters.push(childCluster);
        return true;
      }

      if (
        c.subclusters &&
        this.appendClusterToClusterList(c.subclusters, targetName, childCluster)
      ) {
        return true;
      }
    }
    return false;
  }
}
