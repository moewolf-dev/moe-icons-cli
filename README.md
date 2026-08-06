# moeicons

Public CLI for the Moeicons icon library. Installs icon style groups into your
project, manages login/tokens, generates React/Vue proxy components, and exposes
an MCP server for AI clients.

## Commands

```text
moeicons                    interactive guided flow (free / pro / login)
moeicons install [group]    install an icon group
moeicons login              browser login (PKCE)
moeicons logout             clear local session
moeicons account            show account/tier info
moeicons groups             list available icon groups
moeicons generate           generate React/Vue proxy components
moeicons mcp                start the MCP stdio server
moeicons --version          show version
moeicons --help             show help
```

## Security

- Tokens are stored in the OS keychain where available.
- API keys are never logged or written in plaintext.
- Installation is transactional: failures never corrupt an existing project.
- Downloads verify SHA-256 and never shell out to `unzip`/`tar`.

## Status

Scaffold in progress (Phase 5 of the Moeicons development plan).
