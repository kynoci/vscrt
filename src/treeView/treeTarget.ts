import { CRTConfigNode } from "../config/vscrtConfig";

/**
 * A shape-only target passed to command handlers. Built synthetically by the
 * webview provider from a path, replacing the old CRTTreeItem (which was tied
 * to the native TreeView). Handlers only ever read `.item.type`, `.item.label`,
 * and (for nodes) `.item.config`.
 */
export type CRTTarget =
  | {
      item: {
        type: "cluster" | "subcluster";
        path: string;
        label: string;
      };
    }
  | {
      item: {
        type: "node";
        path: string;
        label: string;
        config: CRTConfigNode;
      };
    };
