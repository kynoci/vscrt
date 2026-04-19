/**
 * Minimal `vscode` module stub for running tests outside the Extension
 * Development Host. Loaded via `src/test/setup.ts`, which overrides
 * `Module._resolveFilename` so production imports of `"vscode"` resolve here
 * at test time only.
 *
 * Only the APIs actually touched by the code under test are implemented.
 * Extend as more coverage is added.
 */

import * as path from "path";

/* -------- Uri -------- */

export class Uri {
  public readonly scheme: string;
  public readonly authority: string = "";
  public readonly path: string;
  public readonly query: string = "";
  public readonly fragment: string = "";

  private constructor(scheme: string, fsPathValue: string) {
    this.scheme = scheme;
    this.path = fsPathValue;
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }

  static file(p: string): Uri {
    return new Uri("file", p);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, path.join(base.path, ...segments));
  }

  static parse(value: string): Uri {
    const m = value.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
    if (m) {
      return new Uri(m[1], m[2]);
    }
    return new Uri("file", value);
  }
}

/* -------- enums -------- */

export enum TerminalLocation {
  Panel = 1,
  Editor = 2,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

/* -------- EventEmitter -------- */

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(e: T): void {
    for (const l of this.listeners.slice()) {
      try {
        l(e);
      } catch {
        // swallow listener errors — real vscode does the same
      }
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export interface Disposable {
  dispose(): void;
}

/* -------- window (with test hooks) -------- */

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  password?: boolean;
  ignoreFocusOut?: boolean;
  value?: string;
  placeHolder?: string;
  validateInput?: (value: string) => string | null | undefined | Thenable<string | null | undefined>;
}

export type Thenable<T> = PromiseLike<T>;

type ShowInputBox = (options?: InputBoxOptions) => Promise<string | undefined>;
type ShowMessage = (
  message: string,
  ...rest: unknown[]
) => Promise<string | undefined>;

interface WindowStub {
  showInputBox: ShowInputBox;
  showErrorMessage: ShowMessage;
  showInformationMessage: ShowMessage;
  showWarningMessage: ShowMessage;
  createTerminal: (options: unknown) => Terminal;
  createStatusBarItem: () => StatusBarItem;
  createOutputChannel: (name: string) => OutputChannel;
  registerWebviewViewProvider: () => Disposable;
  registerTreeDataProvider: () => Disposable;
}

export interface Terminal {
  name: string;
  show(preserveFocus?: boolean): void;
  sendText(text: string, addNewLine?: boolean): void;
  dispose(): void;
}

export interface StatusBarItem extends Disposable {
  text: string;
  show(): void;
  hide(): void;
}

export interface OutputChannel extends Disposable {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  /** Test-only: lines captured via appendLine. Not on real vscode. */
  readonly __lines: string[];
}

const defaultInputBox: ShowInputBox = async () => undefined;
const defaultMessage: ShowMessage = async () => undefined;

export const window: WindowStub = {
  showInputBox: defaultInputBox,
  showErrorMessage: defaultMessage,
  showInformationMessage: defaultMessage,
  showWarningMessage: defaultMessage,
  createTerminal: () => ({
    name: "stub",
    show: () => undefined,
    sendText: () => undefined,
    dispose: () => undefined,
  }),
  createStatusBarItem: () => ({
    text: "",
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  createOutputChannel: (name: string): OutputChannel => {
    const lines: string[] = [];
    return {
      name,
      append: (v: string) => {
        // Treat like appendLine — splits on \n so behaviour matches real.
        if (v.includes("\n")) {
          for (const part of v.split("\n")) {
            lines.push(part);
          }
        } else {
          const last = lines.length > 0 ? lines[lines.length - 1] : undefined;
          if (last !== undefined) {
            lines[lines.length - 1] = last + v;
          } else {
            lines.push(v);
          }
        }
      },
      appendLine: (v: string) => {
        lines.push(v);
      },
      clear: () => {
        lines.length = 0;
      },
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
      __lines: lines,
    };
  },
  registerWebviewViewProvider: () => ({ dispose: () => undefined }),
  registerTreeDataProvider: () => ({ dispose: () => undefined }),
};

/* -------- workspace.fs (in-memory) -------- */

const files = new Map<string, Uint8Array>();
const dirs = new Set<string>();

function keyOf(uri: Uri): string {
  return uri.fsPath;
}

export const workspace = {
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const data = files.get(keyOf(uri));
      if (!data) {
        const err = new Error(`ENOENT: ${uri.fsPath}`) as NodeJS.ErrnoException;
        err.code = "FileNotFound";
        throw err;
      }
      return data;
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      files.set(keyOf(uri), content);
    },
    async createDirectory(uri: Uri): Promise<void> {
      dirs.add(keyOf(uri));
    },
    async stat(uri: Uri): Promise<{ type: FileType; size: number }> {
      const data = files.get(keyOf(uri));
      if (data) {
        return { type: FileType.File, size: data.byteLength };
      }
      if (dirs.has(keyOf(uri))) {
        return { type: FileType.Directory, size: 0 };
      }
      const err = new Error(`ENOENT: ${uri.fsPath}`) as NodeJS.ErrnoException;
      err.code = "FileNotFound";
      throw err;
    },
    async delete(uri: Uri): Promise<void> {
      files.delete(keyOf(uri));
      dirs.delete(keyOf(uri));
    },
  },
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  }),
};

/* -------- l10n (identity stub — returns the source string) -------- */

export const l10n = {
  /**
   * Identity implementation of vscode.l10n.t. Accepts both the
   * string-first and options-object overloads from the real API.
   * Tests assert against the default (English) strings.
   */
  t(...args: unknown[]): string {
    const first = args[0];
    if (typeof first === "string") {
      const rest = args.slice(1);
      return rest.length === 0 ? first : formatPositional(first, rest);
    }
    if (first && typeof first === "object" && "message" in (first as Record<string, unknown>)) {
      return String((first as { message: string }).message);
    }
    return "";
  },
  bundle: undefined as Record<string, string> | undefined,
  uri: undefined,
};

function formatPositional(template: string, args: unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (_m, n) => {
    const v = args[Number(n)];
    return v === undefined ? "" : String(v);
  });
}

/* -------- test-only hooks --------
 *
 * Tests import from "./stubs/vscode" directly to access these helpers, but
 * they live on the same module that production code imports via "vscode" at
 * test time. That's fine: production code never references them.
 */

/* -------- TreeItem + ThemeIcon -------- */

export class ThemeIcon {
  public readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class TreeItem {
  public label: string | { label: string };
  public description?: string;
  public tooltip?: string;
  public iconPath?: ThemeIcon | Uri | { light: Uri; dark: Uri };
  public collapsibleState?: number;
  public contextValue?: string;
  public command?: unknown;
  constructor(label: string | { label: string }, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export function __resetStub(): void {
  window.showInputBox = defaultInputBox;
  window.showErrorMessage = defaultMessage;
  window.showInformationMessage = defaultMessage;
  window.showWarningMessage = defaultMessage;
  files.clear();
  dirs.clear();
}

export function __setShowInputBox(fn: ShowInputBox): void {
  window.showInputBox = fn;
}

export function __setShowInformationMessage(fn: ShowMessage): void {
  window.showInformationMessage = fn;
}

export function __setShowErrorMessage(fn: ShowMessage): void {
  window.showErrorMessage = fn;
}

export function __setShowWarningMessage(fn: ShowMessage): void {
  window.showWarningMessage = fn;
}

export function __fsPutFile(uri: Uri, content: Uint8Array): void {
  files.set(keyOf(uri), content);
}

export function __fsGetFile(uri: Uri): Uint8Array | undefined {
  return files.get(keyOf(uri));
}

export function __fsHasDir(uri: Uri): boolean {
  return dirs.has(keyOf(uri));
}
