<p align="center">
  <a href="https://github.com/Paroxity/ParoxityCode/releases">
    <img src="./assets/paroxity/paroxity-web-icon-192x192.png" width="80" height="80" alt="Paroxity Code logo" />
  </a>
</p>

<h1 align="center">Paroxity Code</h1>

<p align="center">An unofficial fork of T3 Code with Jujutsu (jj) and Tangled support.</p>

<p align="center">
  <a href="https://github.com/Paroxity/ParoxityCode/releases"><strong>Releases</strong></a> ·
  <a href="./FORK.md">Fork notes</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://github.com/pingdotgg/t3code">Upstream</a>
</p>

> Paroxity Code is an **unofficial fork** based on the MIT-licensed [T3 Code](https://github.com/pingdotgg/t3code) source code. It is not affiliated with, endorsed by, or maintained by T3 Tools, Inc.

Paroxity Code runs the coding agents on your machine—Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent—and gives them one fast desktop, web, and remote interface.

## What this fork adds

- **Jujutsu (`jj`) support.** Colocated `.jj` repositories use Jujutsu for checkpoints, diffs, status, workspaces, commit, push (including push rewrite), and pull requests. Requires `jj` 0.46.0 or newer on `PATH`, falling back to Git when unavailable.
- **Tangled integration.** Native source control provider for [Tangled](https://tangled.org), the AT Protocol git forge, with public OAuth sign-in, pull request rounds, interdiffs, and knot writes.
- **Paroxity Code release channel.** Self-contained CLI archives (`linux-x64`, `linux-arm64`, `darwin-arm64`) and a signed, notarized macOS arm64 desktop app published from [Paroxity/ParoxityCode](https://github.com/Paroxity/ParoxityCode/releases).

## Install

### Desktop app (macOS arm64)

Download the latest `.dmg` from [Releases](https://github.com/Paroxity/ParoxityCode/releases) and drag **Paroxity Code (Beta).app** into **Applications**. Subsequent updates download automatically from this repository.

### Command line

Installs the `t3` CLI from `Paroxity/ParoxityCode` releases (Linux x64/arm64 and macOS arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/Paroxity/ParoxityCode/paroxity/stable/scripts/install.sh | sh
```

To move an existing `t3` installation onto Paroxity Code:

```bash
T3CODE_RELEASE_BASE_URL=https://github.com/Paroxity/ParoxityCode/releases/download t3 update <version>
```

### Sign in to an agent

Paroxity Code drives the coding agents already installed and signed in on your machine (for example, `claude auth login` or `codex login`). See [Provider setup](./docs/user/install.md#providers) for each agent.

## Documentation

- [Fork architecture, release process, and upstream merges](./FORK.md)
- [Source control (Git, Jujutsu, and Tangled)](./docs/user/source-control.md)
- [Install and first run](./docs/user/install.md)
- [Remote access](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)

[All docs](./docs/README.md) has the full list.

## Development

The default branch is `paroxity/stable`. Read [FORK.md](./FORK.md) before opening a PR, merging an upstream release, or cutting a build, and see the [development runbook](./docs/operations/00_development.md#first-checkout) to build from source.

## License and attribution

The source code in this repository is licensed under the [MIT License](./LICENSE).

Paroxity Code is derived from [pingdotgg/t3code](https://github.com/pingdotgg/t3code). The T3 Code name, logos, and branding remain trademarks of T3 Tools, Inc.; see [TRADEMARK.md](./TRADEMARK.md).
