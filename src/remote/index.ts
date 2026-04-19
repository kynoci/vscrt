/**
 * Public barrel for the headless remote core.
 *
 * The VS Code extension imports everything from here. Host-agnostic
 * consumers (the `vscrt-remote` CLI, future plugins) pick specific
 * sub-paths (e.g. `../remote/actions/connect`) so they don't drag in
 * VS Code-bound wrappers they can't use.
 *
 * Layout:
 *   core/       — pure logic (no `vscode` imports)
 *   host/       — VS Code-specific glue (adapter + extension-facing
 *                 convenience wrappers)
 *   actions/    — high-level flows (connect / test / sftp) taking a
 *                 HostAdapter
 *   telemetry/  — audit log + session recorder
 *   profile/    — config-file reader (CLI helper)
 *   cli/        — the `vscrt-remote` binary
 *
 * See docs/PLAN_5_HEADLESS_REMOTE_CORE.md.
 */

// ─── HostAdapter seam ──────────────────────────────────────────────
export type {
  ConfirmOptions,
  ConnectionLogMode,
  HostAdapter,
  HostKeyPolicy,
  OpenTerminalOptions,
  SessionRecordingMode,
  TerminalHandle,
  TerminalLocation,
} from "./host/hostAdapter";

export { VscodeHostAdapter } from "./host/vscodeHostAdapter";
export type { VscodeHostAdapterDeps } from "./host/vscodeHostAdapter";

// ─── Extension-facing convenience APIs (legacy signatures) ─────────
export {
  CRTSshService,
  resolveHostKeyCheck,
  testConnection,
} from "./host/vscodeSshService";

export {
  associateTerminal,
  cleanupAllNowSync,
  cleanupTerminal,
  detectShellKind,
  runInTerminal,
} from "./host/vscodeTerminal";
export type { RunInTerminalOptions } from "./host/vscodeTerminal";

export {
  buildSftpFileOpEntry,
  recordConnectStart,
  recordSessionMetadata,
  recordSftpFileOp,
} from "./host/vscodeSessionTelemetry";

// ─── Action-level APIs (HostAdapter-taking, for CLI + tests) ───────
export { connect } from "./actions/connect";
export type { ConnectOptions } from "./actions/connect";
export { sftp, buildSftpShellCommand } from "./actions/sftp";
export type { SftpOptions, BuildSftpShellCommandOptions } from "./actions/sftp";
export {
  classifyError,
  computeKillTimeoutMs,
  resolveProbeAuthMode,
} from "./actions/test";
export type { TestOptions, TestResult, TestOutcome } from "./actions/test";

// ─── Core building blocks ──────────────────────────────────────────
export {
  resolveAuthMode,
  resolveNonInteractiveAuthMode,
  hasSshAuthSock,
} from "./core/authResolver";
export type {
  ResolvedAuthMode,
  AuthResolutionContext,
} from "./core/authResolver";

export { detectSshAgent } from "./core/sshAgent";
export type { SshAgentStatus } from "./core/sshAgent";

export {
  appendKnownHostsLine,
  computeFingerprint,
  defaultKnownHostsPath,
  extractHost,
  formatKnownHostsKey,
  isHostKnown,
  parseHostKeyPolicy,
  pickPreferredKey,
  removeHostFromKnownHosts,
  scanHostKey,
} from "./core/hostKey";
export type { ScannedKey } from "./core/hostKey";

export {
  isValidEntry,
  lookupFingerprint,
  sanitiseManifest,
} from "./core/fingerprintManifest";
export type {
  FingerprintEntry,
  ManifestLookupResult,
} from "./core/fingerprintManifest";

export { isWildcard, parseSshConfig } from "./core/sshConfigParser";
export type { SshHostEntry } from "./core/sshConfigParser";

export {
  buildBaseSshArgs,
  buildDisplayTarget,
  classifySshTarget,
  expandTilde,
  getSftpCommand,
  getSshCommand,
  getSshpassCommand,
  hasUserAtHost,
  isValidJumpHost,
  isValidPortForward,
  resolveEndpoint,
  sshArgsToSftpArgs,
  trimToUndefined,
} from "./core/helpers";
export type {
  BuildBaseSshArgsOptions,
  HostKeyCheckMode,
  SshTargetKind,
} from "./core/helpers";

export {
  buildBashArgvSshpassCommand,
  buildBashPipeCommand,
  buildBashSshpassCommand,
  buildPowerShellArgvSshpassCommand,
  buildPowerShellPipeCommand,
  buildPowerShellSshpassCommand,
  classifyShellKind,
  cleanupOrphanFiles,
  psSingleQuote,
  servePasswordViaLoopback,
  servePasswordViaPipe,
  shSingleQuote,
  writeSecurePasswordFile,
} from "./core/passwordDelivery";
export type { ShellKind } from "./core/passwordDelivery";

export {
  classifyInstallError,
  installPublicKey,
} from "./core/keyInstall";
export type { InstallKeyResult } from "./core/keyInstall";

// Long-lived session primitives (the SFTP Browser's argv / spawn
// layer — fine-grained alternative to the one-shot `connect` / `sftp`
// actions for callers that fire many short ssh/sftp children per
// session).
export {
  ChildTracker,
  buildSshInvocation,
} from "./core/session";
export type {
  BuildInvocationOptions,
  SshInvocation,
  UnsealPassword,
} from "./core/session";

export {
  listRemoteDirectory,
  runSftpBatch,
  runSshDownloadToFile,
  runSshRemote,
  runSshUploadFromFile,
} from "./core/sessionRunners";

export {
  normalizeRemotePath,
  parseLsLong,
  shellQuoteRemotePath,
} from "./core/lsOutputParser";
export type { FileEntry, FileEntryKind } from "./core/lsOutputParser";

// ─── Telemetry building blocks ─────────────────────────────────────
export {
  CONNECTION_LOG_FILENAME,
  CONNECTION_LOG_MAX_BYTES,
  CONNECTION_LOG_ROTATED_SUFFIX,
  appendEntry,
  makeEntry,
  maybeRotate,
  parseConnectionLogMode,
  readLastN,
  shapeEntryForDisk,
} from "./telemetry/connectionLog";
export type {
  ConnectionLogEntry,
  ConnectionOutcome,
  SessionKind,
  SftpAction,
} from "./telemetry/connectionLog";

export {
  filenameFor,
  listSessionRecordings,
  parseSessionRecordingMode,
  sessionsDir,
  slugifyName,
  writeSessionMetadata,
} from "./telemetry/sessionRecorder";
export type { SessionFile, SessionMetadata } from "./telemetry/sessionRecorder";

export {
  filenameForTranscript,
  openTranscript,
} from "./telemetry/transcriptWriter";
export type { OpenTranscriptOptions, TranscriptWriter } from "./telemetry/transcriptWriter";
