/**
 * Data shapes persisted in ~/.vscrt/vscrtConfig.json. Kept separate from the
 * service class so pure helpers (migrations, path lookups) and tests can
 * depend on the types without pulling in the rest of CRTConfigService.
 */

export interface CRTConfig {
  folder?: CRTConfigCluster[];
  // Optional top-level settings. Config-file values beat VS Code user
  // settings when resolving terminal location (but per-node overrides and
  // the explicit "open in editor" button still win above them).
  "vsCRT.doubleClickTerminalLocation"?: CRTTerminalLocation;
  "vsCRT.buttonClickTerminalLocation"?: CRTTerminalLocation;
  /**
   * Named sets of servers that launch together — for morning/pre-deploy/
   * post-incident routines that span folders. Each target optionally
   * overrides the terminal location and adds a millisecond stagger so
   * ten simultaneous auth prompts don't race.
   */
  launchProfiles?: CRTLaunchProfile[];
  /**
   * Pre-shared SHA-256 fingerprints for known-good hosts. The TOFU
   * modal is skipped when the live scan matches a manifest entry;
   * mismatches still get surfaced so a rotated-or-compromised host is
   * never silently accepted.
   */
  knownFingerprints?: Array<{
    host: string;
    port?: number;
    sha256: string;
    comment?: string;
  }>;
}

export interface CRTLaunchProfile {
  name: string;
  description?: string;
  targets: CRTLaunchTarget[];
}

export interface CRTLaunchTarget {
  /** Slash-joined path into the folder tree, e.g. "Prod/Web". */
  nodePath: string;
  /** Optional per-target override of the shared terminal location. */
  terminalLocation?: CRTTerminalLocation;
  /** Optional stagger in ms before launching this target. */
  delayMs?: number;
}

export interface CRTConfigCluster {
  name: string;
  icon?: string; // codicon name (without the "codicon-" prefix)
  subfolder?: CRTConfigCluster[];
  nodes?: CRTConfigNode[];
}

export type CRTAuthMethod = "password" | "publickey";
export type CRTPasswordDelivery = "argv" | "tempfile" | "pipe";
export type CRTPasswordStorage = "secretstorage" | "passphrase";
export type CRTTerminalLocation = "panel" | "editor";

export interface CRTConfigNode {
  name: string;
  endpoint: string;
  icon?: string; // codicon name (without the "codicon-" prefix)
  hostName?: string;
  user?: string;
  preferredAuthentication?: CRTAuthMethod;
  identityFile?: string;
  extraArgs?: string;
  /**
   * SSH ProxyJump spec: `[user@]host[:port]`, comma-separated for chains
   * (e.g. `alice@bastion1,bob@bastion2`). Renders at connect time as
   * `ssh -o ProxyJump=<this>`. Works with both password and publickey auth.
   */
  jumpHost?: string;
  /**
   * Port-forward specifications, each rendered as a raw `-L`, `-R`, or
   * `-D` argument at connect time. Examples:
   *   - "-L 3306:db.internal:3306"  — local → remote tunnel
   *   - "-R 8080:localhost:8080"    — remote → local reverse tunnel
   *   - "-D 1080"                   — dynamic SOCKS proxy
   * Constrained to a shell-safe character set (validated by the schema).
   */
  portForwards?: string[];
  /**
   * Environment variables injected into the spawned terminal process
   * before ssh runs. Useful for `TERM=xterm-256color`, proxy vars, etc.
   * NOT forwarded to the remote host (that's what SendEnv / `-o SetEnv`
   * are for — users can reach those via extraArgs).
   */
  env?: Record<string, string>;
  password?: string; // "@secret:<uuid>", "enc:v3:<...>", or legacy plaintext
  passwordDelivery?: CRTPasswordDelivery;
  passwordStorage?: CRTPasswordStorage; // opt-in: "passphrase" encrypts in-file via Argon2id+AES-GCM
  terminalLocation?: CRTTerminalLocation; // per-node override; wins over user settings
  /**
   * Saved shell snippets that run inside this server's terminal. Each entry
   * becomes a QuickPick item under "vsCRT: Run Command…". The `script` is
   * sent verbatim via `terminal.sendText(script, true)` after the terminal
   * spawns, so it inherits whatever shell + env the server is configured
   * with.
   */
  commands?: CRTNodeCommand[];
  /**
   * When true, emit `ssh -A` so the local agent's keys are forwarded to
   * the remote session. Off by default — agent forwarding is convenient
   * but lets the remote host impersonate you to anything your agent can
   * authenticate to.
   */
  agentForwarding?: boolean;
  /**
   * Maps to `-o AddKeysToAgent=<value>`. When set, ssh adds freshly
   * unlocked keys to the running agent for re-use across sessions.
   */
  addKeysToAgent?: "yes" | "no" | "ask" | "confirm";
  /**
   * Per-node override for session recording. `"off"` disables recording
   * for this node even when the global `vsCRT.sessionRecording` is on;
   * any non-off value overrides the global in the other direction.
   * Default (unset) honours the global setting.
   */
  recordSession?: "off" | "minimal" | "full";
  /** Maps to `ssh -o ConnectTimeout=<n>`. */
  connectTimeoutSeconds?: number;
  /** Maps to `ssh -o ServerAliveInterval=<n>`. */
  serverAliveIntervalSeconds?: number;
  /** Maps to `ssh -o IdentitiesOnly=yes|no`. */
  identitiesOnly?: boolean;
  /**
   * Escape hatch for ~/.ssh/config directives we don't natively model.
   * Each key/value becomes `-o <Key>=<Value>` at connect time. Keys
   * are lower-cased on ingest from the parser; re-cased by ssh itself
   * since options are case-insensitive.
   */
  extraSshDirectives?: Record<string, string>;
}

export interface CRTNodeCommand {
  name: string;
  script: string;
  description?: string;
}

export function createDefaultConfig(): CRTConfig {
  return {
    folder: [
      {
        name: "Production",
        nodes: [{ name: "Prod Web", endpoint: "deploy@prod-web" }],
        subfolder: [
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
  };
}
