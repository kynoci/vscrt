/**
 * Pty-tee transcript writer. Complement to `sessionRecorder.ts`'s
 * metadata: when the user opts into `full` session recording, every
 * byte of stdout the spawned shell emits is mirrored to a gzip file
 * at `~/.vscrt/sessions/<ISO>-<server>-<pid>.log.gz`.
 *
 * Deliberately NOT a full Pseudoterminal replacement. Implementing
 * `vscode.Pseudoterminal` means we'd have to re-host the child
 * process lifecycle, handle resize, stdin forwarding, env passing,
 * and interactive prompts — all of which the existing
 * `runInTerminal`-via-shell path does well. Instead, this writer runs
 * as a standalone file sink the connect path can feed into on a
 * best-effort basis.
 *
 * The writer exposes a streaming API (`append(chunk)`, `close()`) so
 * callers can tee a terminal's output without buffering the entire
 * session in memory.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createGzip, type Gzip } from "zlib";
import { log } from "../../log";
import { sessionsDir } from "./sessionRecorder";

export interface TranscriptWriter {
  /** Write a chunk of terminal output to the gzip sink. */
  append(chunk: string | Buffer): void;
  /** Flush + close. Safe to call more than once. */
  close(): Promise<void>;
  /** Full path of the transcript file on disk. */
  readonly filePath: string;
}

export interface OpenTranscriptOptions {
  serverName: string;
  pid?: number;
  timestamp?: Date;
  home?: string;
}

export function filenameForTranscript(
  serverName: string,
  pid: number,
  timestamp: Date = new Date(),
): string {
  const iso = timestamp.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${iso}-${slug}-${pid}.log.gz`;
}

/**
 * Create a gzip transcript file and return a streaming sink. The
 * underlying `fs.createWriteStream` + `zlib.createGzip` pair keeps
 * memory flat regardless of session length.
 */
export async function openTranscript(
  opts: OpenTranscriptOptions,
): Promise<TranscriptWriter> {
  const pid = opts.pid ?? process.pid;
  const home = opts.home ?? os.homedir();
  const dir = sessionsDir(home);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const filename = filenameForTranscript(
    opts.serverName,
    pid,
    opts.timestamp ?? new Date(),
  );
  const filePath = path.join(dir, filename);

  const fileStream = fs.createWriteStream(filePath, {
    mode: 0o600,
    flags: "w",
  });
  const gzip: Gzip = createGzip();
  gzip.pipe(fileStream);

  let closed = false;
  const closePromise = new Promise<void>((resolve) => {
    fileStream.on("close", () => resolve());
    fileStream.on("error", (err) => {
      log.warn(`transcript fileStream error for ${filePath}:`, err);
      resolve();
    });
  });

  return {
    filePath,
    append(chunk: string | Buffer): void {
      if (closed) {
        return;
      }
      try {
        gzip.write(chunk);
      } catch (err) {
        log.warn("transcript write failed:", err);
      }
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      try {
        gzip.end();
      } catch (err) {
        log.warn("transcript gzip.end() failed:", err);
      }
      await closePromise;
    },
  };
}
