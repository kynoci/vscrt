/**
 * Shared helpers for integration tests: looks up the activated `vsCRT`
 * extension, waits on async conditions, and temporarily monkey-patches
 * `vscode.window.show*` prompts so we can drive interactive commands
 * without a real user.
 *
 * Keeping these in one place means every new integration test starts
 * with `await activateExt()` and `withStubbed(...)` instead of
 * reimplementing the same ceremony.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import type { VscrtExports } from "../../extension";

export const EXT_ID = "kynoci.vscrt";

export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(
  predicate: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await predicate();
      if (v !== undefined && v !== false) {
        return v as T;
      }
    } catch (err) {
      lastErr = err;
    }
    await wait(intervalMs);
  }
  throw new Error(
    `waitFor: predicate never satisfied within ${timeoutMs}ms${lastErr ? ` (last error: ${String(lastErr)})` : ""}`,
  );
}

export async function activateExt(): Promise<VscrtExports> {
  const ext = vscode.extensions.getExtension<VscrtExports>(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} must be present in the test host`);
  return ext.isActive ? (ext.exports as VscrtExports) : await ext.activate();
}

/**
 * Safely monkey-patch properties on `vscode.window` for the duration of
 * `fn`, restoring the originals afterwards (including on throw). Used
 * to stub showInputBox / showQuickPick / showSaveDialog / showOpenDialog
 * / showWarningMessage when a command under test would otherwise block
 * on a real user dialog.
 *
 * Stubs are deliberately typed as `unknown` because vscode.window's
 * overloads (especially showQuickPick's single-vs-many-picker union)
 * defeat structural assignability in TypeScript — real production code
 * narrows at a call site we don't have.
 */
export async function withStubbed<T>(
  stubs: Record<string, unknown>,
  fn: () => Promise<T> | Thenable<T>,
): Promise<T> {
  const window = vscode.window as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  for (const key of Object.keys(stubs)) {
    originals.set(key, window[key]);
    window[key] = stubs[key];
  }
  try {
    return await Promise.resolve(fn());
  } finally {
    for (const [key, value] of originals) {
      window[key] = value;
    }
  }
}

/** Convenience: build a QuickPick stub that always picks the first item. */
export function pickFirst(): (
  items: unknown,
) => Promise<vscode.QuickPickItem | undefined> {
  return async (items: unknown) => {
    const resolved = (await Promise.resolve(
      items,
    )) as readonly vscode.QuickPickItem[];
    return resolved.find((i) => i.kind !== vscode.QuickPickItemKind.Separator);
  };
}

/** Convenience: stub showInputBox with a sequence of responses (in order). */
export function inputBoxSequence(
  responses: ReadonlyArray<string | undefined>,
): () => Promise<string | undefined> {
  let i = 0;
  return async () => {
    if (i >= responses.length) {
      throw new Error(
        `inputBoxSequence exhausted after ${i} call(s); expected at most ${responses.length}`,
      );
    }
    return responses[i++];
  };
}
