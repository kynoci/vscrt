import * as vscode from "vscode";
import {
  CRTConfig,
  CRTConfigCluster,
  CRTConfigNode,
  CRTConfigService,
} from "../ConfigSSH/crtConfig";

/* -------------------------------------------------------
 *   TYPE DEFINITIONS (Cluster / Subcluster / Node)
 * -----------------------------------------------------*/

export type CRTItem = CRTCluster | CRTSubcluster | CRTNode;

export interface CRTCluster {
  type: "cluster";
  label: string;
  path: string;
  children: CRTItem[];
}

export interface CRTSubcluster {
  type: "subcluster";
  label: string;
  path: string;
  children: CRTItem[];
}

export interface CRTNode {
  type: "node";
  label: string;
  path: string;
  description?: string;
  config: CRTConfigNode;
}

/* -------------------------------------------------------
 *   TREE ITEM CLASS (UI Representation)
 * -----------------------------------------------------*/

export class CRTTreeItem extends vscode.TreeItem {
  constructor(public readonly item: CRTItem) {
    const collapsibleState =
      item.type === "cluster" || item.type === "subcluster"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

    super(item.label, collapsibleState);

    // unique id helps VS Code track items
    this.id = item.path;

    if (item.type === "node") {
      this.description = item.config.endpoint ?? item.description ?? "";
      this.iconPath = new vscode.ThemeIcon("terminal");
      this.contextValue = "vscrtNode";
    }

    if (item.type === "cluster") {
      this.iconPath = new vscode.ThemeIcon("folder");
      this.contextValue = "vscrtCluster";
    }

    if (item.type === "subcluster") {
      this.iconPath = new vscode.ThemeIcon("folder-library");
      this.contextValue = "vscrtSubcluster";
    }
  }
}

/* -------------------------------------------------------
 *   TREE DATA PROVIDER
 * -----------------------------------------------------*/

export class CRTProvider implements vscode.TreeDataProvider<CRTTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    CRTTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: CRTItem[] = [];
  private configManager = new CRTConfigService();

  constructor() {
    this.init();
  }

  /** Called once when provider is created */
  private async init() {
    await this.reloadFromConfig();
    this.refresh();
  }

  /** Public: can be reused by a "Reload Config" command later */
  async reloadFromConfig() {
    const cfg = await this.configManager.loadConfig();

    if (!cfg) {
      this.roots = this.getDemoRoots();
      return;
    }

    this.roots = this.mapConfigToItems(cfg);

    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CRTTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CRTTreeItem): vscode.ProviderResult<CRTTreeItem[]> {
    if (!element) {
      // root level
      return this.roots.map((i) => new CRTTreeItem(i));
    }

    if (element.item.type === "cluster" || element.item.type === "subcluster") {
      return element.item.children.map((child) => new CRTTreeItem(child));
    }

    // node → no children
    return [];
  }

  /* ------------ mapping ConfigSSH -> CRTItem[] ------------ */

  private mapConfigToItems(cfg: CRTConfig): CRTItem[] {
    const items: CRTItem[] = [];

    for (const c of cfg.clusters ?? []) {
      items.push(this.convertCluster(c));
    }

    for (const n of cfg.nodes ?? []) {
      items.push(this.convertNode(n, null));
    }

    return items;
  }

  private convertCluster(c: CRTConfigCluster, parentPath = ""): CRTCluster {
    const myPath = parentPath ? `${parentPath}/${c.name}` : c.name;
    const children: CRTItem[] = [];

    for (const sc of c.subclusters ?? []) {
      children.push(this.convertSubcluster(sc, myPath));
    }

    for (const n of c.nodes ?? []) {
      children.push(this.convertNode(n, myPath));
    }

    return {
      type: "cluster",
      label: c.name,
      path: myPath,
      children,
    };
  }

  private convertSubcluster(
    c: CRTConfigCluster,
    parentPath: string
  ): CRTSubcluster {
    const myPath = `${parentPath}/${c.name}`;
    const children: CRTItem[] = [];

    for (const sc of c.subclusters ?? []) {
      children.push(this.convertSubcluster(sc, myPath));
    }

    for (const n of c.nodes ?? []) {
      children.push(this.convertNode(n, myPath));
    }

    return {
      type: "subcluster",
      label: c.name,
      path: myPath,
      children,
    };
  }

  private convertNode(n: CRTConfigNode, parentPath: string | null): CRTNode {
    const myPath = parentPath ? `${parentPath}/${n.name}` : n.name;
    return {
      type: "node",
      label: n.name,
      path: myPath,
      description: n.endpoint,
      config: n,
    };
  }

  /** Fallback if config totally fails */
  private getDemoRoots(): CRTItem[] {
    return [
      {
        type: "cluster",
        label: "Demo Cluster",
        path: "Demo Cluster",
        children: [
          {
            type: "node",
            label: "Demo Node",
            path: "Demo Cluster/Demo Node",
            description: "demo@endpoint",
            config: {
              name: "Demo Node",
              endpoint: "demo@endpoint",
            },
          },
        ],
      },
    ];
  }
}

export class CRTDragAndDropController
  implements vscode.TreeDragAndDropController<CRTTreeItem>
{
  // id must be stable string
  readonly dropMimeTypes = ["application/vnd-vscrt-item"];
  readonly dragMimeTypes = ["application/vnd-vscrt-item"];

  constructor(
    private readonly configService: CRTConfigService,
    private readonly provider: CRTProvider
  ) {}

  handleDrag(
    source: CRTTreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void {
    if (!source.length) {
      return;
    }

    const item = source[0].item;
    // we'll serialize just the path + type
    dataTransfer.set(
      "application/vnd-vscrt-item",
      new vscode.DataTransferItem(
        JSON.stringify({ path: item.path, type: item.type })
      )
    );
  }

  /** Insert node into a cluster/subcluster by name (non-path) */
  private insertNodeIntoClusterList(
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
        this.insertNodeIntoClusterList(c.subclusters, targetName, node)
      ) {
        return true;
      }
    }
    return false;
  }

  async handleDrop(
    target: CRTTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const raw = dataTransfer.get("application/vnd-vscrt-item");
    if (!raw) {
      return;
    }

    const text = await raw.asString();
    const payload = JSON.parse(text) as { path: string; type: string };

    // For first version: only support dropping NODEs
    if (payload.type !== "node") {
      return;
    }

    // Where are we dropping?
    let newParentName: string | null = null;

    if (target) {
      if (target.item.type === "cluster" || target.item.type === "subcluster") {
        newParentName = target.item.label;
      } else {
        // dropping onto a node → treat as root for now
        newParentName = null;
      }
    }

    // 1. Read config
    const cfg = await this.configService.loadConfig();
    if (!cfg) {
      return;
    }

    // 2. Remove node from old location
    const movedNode = this.extractNodeByPath(cfg, payload.path);
    if (!movedNode) {
      return;
    }

    // 3. Insert node into new parent (or root)
    if (newParentName === null) {
      if (!cfg.nodes) {
        cfg.nodes = [];
      }
      cfg.nodes.push(movedNode);
    } else {
      if (!cfg.clusters) {
        cfg.clusters = [];
      }
      const inserted = this.insertNodeIntoClusterList(
        cfg.clusters,
        newParentName,
        movedNode
      );
      if (!inserted) {
        // (optional) log something
        return;
      }
    }

    // 4. Save updated config ONCE
    const uri = await (this.configService as any)["ensureConfigFile"]();
    const newText = JSON.stringify(cfg, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, "utf8"));

    // 5. Refresh view
    await this.provider.reloadFromConfig();
  }

  /** remove node from cfg based on the path string and return it */
  private extractNodeByPath(
    cfg: CRTConfig,
    path: string
  ): CRTConfigNode | null {
    const segments = path.split("/"); // e.g. ["Production", "Database", "Prod DB"]

    // If path has only 1 segment, it's a root node
    if (segments.length === 1) {
      if (!cfg.nodes) {
        return null;
      }
      const idx = cfg.nodes.findIndex((n) => n.name === segments[0]);
      if (idx === -1) {
        return null;
      }
      const [node] = cfg.nodes.splice(idx, 1);
      return node;
    }

    // Otherwise, last segment is node name, previous are cluster/subcluster chain
    const nodeName = segments[segments.length - 1];
    const clusterPath = segments.slice(0, -1);

    const parentCluster = this.findClusterByPath(
      cfg.clusters ?? [],
      clusterPath,
      0
    );
    if (!parentCluster || !parentCluster.nodes) {
      return null;
    }

    const idx = parentCluster.nodes.findIndex((n) => n.name === nodeName);
    if (idx === -1) {
      return null;
    }

    const [node] = parentCluster.nodes.splice(idx, 1);
    return node;
  }

  private findClusterByPath(
    clusters: CRTConfigCluster[],
    segments: string[],
    depth: number
  ): CRTConfigCluster | null {
    if (depth >= segments.length) {
      return null;
    }

    const currentName = segments[depth];
    const cluster = clusters.find((c) => c.name === currentName);
    if (!cluster) {
      return null;
    }

    if (depth === segments.length - 1) {
      return cluster;
    }

    return this.findClusterByPath(
      cluster.subclusters ?? [],
      segments,
      depth + 1
    );
  }
}
