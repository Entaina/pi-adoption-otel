# pi-otel

A [pi](https://pi.dev) extension that sends telemetry to **[Adoption](https://adoption.entaina.ai), our product**, using **OTLP/HTTP JSON** logs. Requires Node.js ≥ 22.19; tested with pi 1.0.4.

> **Full content is sent by default:** prompts, responses, system instructions, context, provider payloads, images, and tool arguments/results. These may contain secrets, private code, and personal data. Use a trusted destination and HTTPS outside localhost. Sensitive headers are hidden in header events, but conversation secrets are not redacted. Additional JSON attributes also contain sensitive data; their exclusion from Adoption's analytics store is not guaranteed.

## Installation and setup

Once published on npm:

```bash
pi install npm:pi-otel
pi
```

During development, run `pi install .` from this repository.

Run `/otel setup` to configure the OTLP base endpoint, Adoption token, and email. Select **Save and reload** to save and apply changes. For text fields, an empty answer keeps the current value; `-` clears it.

Settings are saved to `<agent-dir>/pi-otel/config.json`, usually `~/.pi/agent/pi-otel/config.json`, with `0600` permissions. **The token is stored in plain text**, after confirmation. The input dialog does not mask what you type.

You can also configure the extension through environment variables:

```bash
export PI_OTEL_ENDPOINT="https://adoption.entaina.ai/api"
export PI_OTEL_TOKEN="YOUR_ADOPTION_TOKEN"
export PI_OTEL_USER_EMAIL="you@example.com"
pi
```

The extension appends `/v1/logs` to the base endpoint unless it already ends with that path. Email is required for account tokens; with personal tokens, Adoption attributes events to the token owner.

Environment variables override saved settings. `.env` files are not loaded automatically. Without an endpoint, the extension does not capture events, recover pending batches, or send data.

## Controls

| Control | Effect |
|---|---|
| `/otel setup` | Configure and reload |
| `/otel status` | Show accepted records, pending records, and errors |
| `/otel flush` | Persist pending records and attempt delivery |
| `--otel-disable` | Disable the extension for this process |
| `--otel-no-content` | Export events and usage without conversation content |

## Environment variables

| Variable | Default |
|---|---|
| `PI_OTEL_ENDPOINT` | No destination |
| `PI_OTEL_TOKEN` | No token |
| `PI_OTEL_USER_EMAIL` | No email |
| `OTEL_SERVICE_NAME` | `pi` |
| `PI_OTEL_ENABLED` | `true` |
| `PI_OTEL_CAPTURE_CONTENT` | `true` |
| `PI_OTEL_CAPTURE_STREAM` | `true` |
| `PI_OTEL_REPLAY_HISTORY` | `true` |
| `PI_OTEL_BATCH_SIZE` | `100` records |
| `PI_OTEL_FLUSH_INTERVAL_MS` | `1000` |
| `PI_OTEL_TIMEOUT_MS` | `10000` |
| `PI_OTEL_SHUTDOWN_TIMEOUT_MS` | `5000` |
| `PI_OTEL_SPOOL_DIR` | `<agent-dir>/pi-otel/outbox` |

Standard `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, and their `OTEL_EXPORTER_OTLP_LOGS_*` variants are also supported. The logs-specific endpoint is used as a complete URL. Logs-specific headers override common headers; `PI_OTEL_TOKEN` overrides both. Only the `http/json` protocol is supported. Only `service.name` and `user.email` are read from `OTEL_RESOURCE_ATTRIBUTES`.

`PI_OTEL_CAPTURE_STREAM=false` skips partial updates, not finalized messages or complete payloads. `PI_OTEL_REPLAY_HISTORY=false` prevents replaying earlier messages, but snapshots and payloads may still contain history when content capture is enabled.

## Capture and delivery

- Captures messages, usage/costs, tools, and pi events without transforming them. Replays active-branch history at startup; snapshots include all branches.
- Captures only what pi exposes. It does not reconstruct hidden reasoning or content already truncated. Load this extension after other extensions to observe their transformations.
- Uses logs, not traces or metrics. Adoption does not guarantee that additional attributes, images, or reasoning will appear as conversation messages.
- Batches are stored **unencrypted** in the local outbox, with `0600` files and directories created with `0700` permissions. The transport token is not stored in batches, but their content may contain secrets.
- HTTP 200 means accepted, not necessarily stored. HTTP 408/429/5xx and network failures are retried; other statuses stop automatic delivery until a manual flush or restart.
- Pending batches survive shutdown. Queues are isolated by destination, product, email, token hash, and content profile. Metadata-only mode does not send older full-content batches; changing the token or destination may leave batches pending in the previous queue.
- There is no disk limit: monitor outbox size. Exactly-once delivery and durability against power loss are not guaranteed; abrupt shutdown can lose records still in memory or cause duplicates on resume.
- Network requests run in the background; serialization and local writes still take time. Notifications go to stderr in modes without UI.

## Development

```bash
npm ci
npm run check
npm test
```

Tests use a local HTTP server, the pi SDK, and a simulated model; they do not send conversations to Adoption.
