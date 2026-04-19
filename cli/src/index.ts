/**
 * Entry point. Parse argv, dispatch to the right verb handler, exit with
 * its return code. Version is inlined at build time via a read of
 * package.json so `vscrt version` doesn't need a runtime fs read.
 */

import { parseArgs } from "./argParser";
import {
  runConnect,
  runDiag,
  runHelp,
  runLs,
  runSftp,
  runVersion,
} from "./commands";
import { formatError } from "./errorUtils";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../package.json") as { version: string };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  for (const w of args.warnings) {
    process.stderr.write(`vscrt: ${w}\n`);
  }

  let code: number;
  switch (args.verb) {
    case "connect":
      code = await runConnect(args);
      break;
    case "sftp":
      code = await runSftp(args);
      break;
    case "ls":
      code = runLs(args);
      break;
    case "diag":
      code = await runDiag(args);
      break;
    case "version":
      code = runVersion(pkg.version);
      break;
    case "help":
    default:
      code = runHelp();
  }
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`vscrt: ${formatError(err)}\n`);
  process.exit(1);
});
