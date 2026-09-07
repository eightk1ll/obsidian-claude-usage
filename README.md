# Claude Usage

Obsidian plugin that shows your Claude subscription usage in the status bar: the 5-hour window, the weekly window and, if present, the weekly window for top-tier models.

The plugin reads the OAuth token from the Claude Code credentials file and uses it to query the usage endpoint. It never writes the token and never refreshes it itself.

## Display

One 14px ring per window, followed by the percentage and the time left until reset (`47m`, `4h52m`, `4d7h`).

- Below the warning threshold: neutral ring
- At or above the warning threshold (default 75 %): ring in `--text-warning`
- At or above the critical threshold (default 90 %): ring in `--text-error` plus a ⚠ glyph, so the state does not depend on colour alone

Hovering the status bar item shows all windows with their reset time and the timestamp of the last fetch. Clicking it shows the same values as a notice.

## Requirements

- Obsidian 1.13.0 or newer, desktop only
- Claude Code installed and signed in via `/login`. The token needs the `user:profile` scope. A token from `claude setup-token` is not sufficient.
- Credentials file at `~/.claude/.credentials.json` (path configurable in settings)

## Installation

Manual:

1. Copy `main.js`, `manifest.json` and `styles.css` to `<Vault>/.obsidian/plugins/claude-usage/`
2. Reload Obsidian and enable the plugin under *Community plugins*

Via BRAT: add `eightk1ll/obsidian-claude-usage` as a beta plugin.

## Settings

| Option | Default | Meaning |
|---|---|---|
| Credentials path | `~/.claude/.credentials.json` | File the token is read from |
| Poll interval | 15 minutes | Time between two API requests |
| Warning threshold | 75 % | Ring switches to warning colour |
| Critical threshold | 90 % | Ring switches to error colour plus glyph |
| Show time until reset | on | Countdown next to the percentage |

The command `Refresh usage now` in the command palette triggers a manual fetch.

## Error handling and backoff

Errors that do not resolve on their own (expired token, 401, 403, 429, network errors) put the plugin on hold. The hold grows with each consecutive failure: 15, 30, 60, 120, 240 minutes. A `Retry-After` header from the server extends the hold but never shortens it. The hold also applies to manual refreshes.

The backoff state is persisted in `data.json`, so restarting Obsidian does not reset it. Without this, a permanent error would produce hundreds of requests overnight and trigger a 429 on its own.

An expired token is detected before the request is sent and shown as a hint. The fix in all cases: run `claude` and execute `/login`.

## Privacy

- The token is read from the local credentials file only. It is sent exclusively to `api.anthropic.com` as a bearer header.
- No telemetry, no third-party services, no data stored outside `data.json` in the plugin folder.
- Network access is limited to the usage endpoint listed below.

## Technical notes

- Endpoint: `https://api.anthropic.com/api/oauth/usage` with header `anthropic-beta: oauth-2025-04-20`
- Requests go through `requestUrl` from the Obsidian API
- No build step: `main.js` runs as is, no dependencies beyond the Obsidian API

## License

MIT
