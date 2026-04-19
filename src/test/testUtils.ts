/**
 * Shared helpers for unit tests. Only consumed from `src/test/` — not imported
 * by production code.
 */

import * as vscode from "vscode";
import { ArgonParams } from "../config/vscrtPassphrase";
import {
  EventEmitter,
  __resetStub,
  __setShowInputBox,
} from "./stubs/vscode";

/**
 * Deliberately weak Argon2id parameters — below OWASP minimums — so unit
 * tests that exercise the passphrase service run in milliseconds instead
 * of ~3 s per derivation. Production uses DEFAULT_PARAMS from
 * `src/config/vscrtPassphrase.ts`.
 */
export const LIGHT_ARGON_PARAMS: ArgonParams = { t: 1, m: 8, p: 1 };

/** In-memory vscode.SecretStorage implementation. */
export class InMemorySecretStorage implements vscode.SecretStorage {
  private data = new Map<string, string>();
  private emitter = new EventEmitter<vscode.SecretStorageChangeEvent>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    this.emitter.fire({ key });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
    this.emitter.fire({ key });
  }

  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }

  get onDidChange(): vscode.Event<vscode.SecretStorageChangeEvent> {
    return this.emitter.event as unknown as vscode.Event<vscode.SecretStorageChangeEvent>;
  }

  /** Non-interface helpers */
  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.data);
  }

  size(): number {
    return this.data.size;
  }
}

/**
 * Configure `vscode.window.showInputBox` to return the given value on every
 * call, regardless of the prompt title. Use `queueInputBoxResponses` for
 * scripted multi-step flows.
 */
export function setInputBoxResponse(value: string | undefined): void {
  __setShowInputBox(async () => value);
}

/** Queue a sequence of responses — each subsequent call pops one off the front. */
export function queueInputBoxResponses(values: (string | undefined)[]): void {
  const queue = [...values];
  __setShowInputBox(async () => {
    if (queue.length === 0) {
      return undefined;
    }
    return queue.shift();
  });
}

/**
 * Reset every test-controlled stub to its default state (showInputBox returns
 * undefined, filesystem empty, etc.). Call this in `beforeEach`.
 */
export function resetVscodeStub(): void {
  __resetStub();
}
