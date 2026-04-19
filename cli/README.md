# vscrt-cli

Command-line companion for the
[vsCRT VS Code extension](https://marketplace.visualstudio.com/items?itemName=kynoci.vscrt).

Most of the value is in the UI — but sometimes you're already in a shell,
you know the server you want, and you don't want to reach for the mouse.
This CLI gives you four verbs:

```bash
vscrt connect <path>          # open the server in a new VS Code terminal
vscrt sftp [<path>]           # open an interactive SFTP terminal
vscrt sftp --browser <path>   # open the SFTP browser panel (preview)
vscrt ls                      # list your configured servers
vscrt diag                    # print diagnostic info for a bug report
```

## Install

```bash
npm install -g vscrt-cli
```

`vscrt connect` shells out to the `code` CLI (the one VS Code ships) and
fires a `vscode://kynoci.vscrt/connect` deep link, so **you need the
vsCRT extension installed** for the connect verb to do anything useful.
`ls` and `diag` are self-contained and work even when VS Code isn't
running.

## Usage

### connect

```bash
vscrt connect Prod/Web           # slash-joined path matches the tree
vscrt connect "Prod/DB/Primary"  # quote paths containing spaces
vscrt connect --json Prod/Web    # don't exec 'code'; print the URL
```

Dry-run with `--json` is useful when you want to embed the URL in a
runbook or Slack message rather than invoking it directly.

### sftp

```bash
vscrt sftp Prod/Web             # interactive sftp terminal
vscrt sftp --browser Prod/Web   # read-write browser panel (preview)
vscrt sftp                      # no path → picker inside the extension
vscrt sftp --json Prod/Web      # dry-run; print the deep-link URL
```

Fires a `vscode://kynoci.vscrt/sftp` or `/sftpBrowser` deep link. The
browser variant supports upload / download / delete / mkdir / rename /
chmod / preview and multi-select bulk ops. Same auth / ProxyJump /
host-key policy as `vscrt connect`.

### ls

```bash
vscrt ls                 # human-readable tree
vscrt ls --json          # JSON for scripting
vscrt ls --filter prod   # only rows whose path or endpoint contains "prod"
```

Reads `~/.vscrt/vscrtConfig.json` directly — no VS Code, no extension
required.

### diag

```bash
vscrt diag
```

Prints versions, config counts, and availability of `ssh`, `sshpass`,
`ssh-keygen`, and friends. Paste the output into an issue on
[github.com/kynoci/vscrt/issues](https://github.com/kynoci/vscrt/issues).

## Security

The CLI never reads or prints passwords. `vscrt connect` resolves your
server path locally but the actual SSH handshake happens in the
extension, using the same secure credential flow as a click-through
connect.

## Development

```bash
cd cli/
npm install
npm run build      # emits dist/vscrt.js
chmod +x dist/vscrt.js
./dist/vscrt.js ls
```
