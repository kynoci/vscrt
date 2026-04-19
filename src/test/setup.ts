/**
 * Mocha setup file — redirects `require("vscode")` to our in-process stub so
 * unit tests can run outside the VS Code Extension Development Host.
 *
 * Wired via `.mocharc.json` (`"require": "out/test/setup.js"`) so it runs
 * before any test file is loaded.
 *
 * Defensive no-op when the real `vscode` module is already resolvable
 * (i.e. we're running inside the Extension Development Host). This keeps
 * the file safe if `.mocharc.json` is ever accidentally picked up by the
 * integration-test runner.
 */

import Module = require("module");
import * as path from "path";

interface ResolvableModule {
  _resolveFilename: (
    request: string,
    parent: NodeJS.Module | null,
    ...rest: unknown[]
  ) => string;
}

const mod = Module as unknown as ResolvableModule;

function realVscodeAvailable(): boolean {
  try {
    mod._resolveFilename("vscode", null);
    return true;
  } catch {
    return false;
  }
}

if (!realVscodeAvailable()) {
  const stubPath = path.resolve(__dirname, "stubs", "vscode.js");
  const original = mod._resolveFilename;

  mod._resolveFilename = function (
    request: string,
    parent: NodeJS.Module | null,
    ...rest: unknown[]
  ): string {
    if (request === "vscode") {
      return stubPath;
    }
    return original.call(this, request, parent, ...rest);
  };
}
