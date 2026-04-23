# homebridge-openclaw-gateway

Homebridge plugin that exposes a simplified REST API so an [OpenClaw](https://docs.openclaw.ai) agent can list and control HomeKit devices. Also includes a built-in event framework that detects HomeKit state changes and surfaces them to OpenClaw with minimal token cost.

### Requirements

- **homebridge-config-ui-x** installed (included in the official Docker image).
- Homebridge started with the **`-I`** (insecure) flag so the UI can read/write characteristics.

### Installation

```bash
npm install homebridge-openclaw-gateway
```

Or via **Homebridge Config UI X**: Plugins → search "openclaw" → Install.

### Minimum configuration

Add to your Homebridge `config.json` under **`platforms`**:

```json
{
  "platform": "OpenClawGateway",
  "name": "OpenClaw Gateway"
}
```

The plugin will automatically detect UI credentials, generate a unique bootstrap token, and listen on port 8865.

### Advanced configuration

```json
{
  "platform": "OpenClawGateway",
  "name": "OpenClaw Gateway",
  "apiPort": 8865,
  "apiBind": "0.0.0.0",
  "token": "my-custom-token",
  "sessionTokenTtl": 300,
  "rateLimit": 100,
  "pollInterval": 30,
  "eventQueueSize": 200,
  "pluginExternalUrl": "http://homebridge.local:8865",
  "homebridgeUiUrl": "http://localhost:8581",
  "homebridgeUiUser": "admin",
  "homebridgeUiPass": "admin"
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `apiPort` | number | `8865` | REST server port |
| `apiBind` | string | `0.0.0.0` | Bind address (`127.0.0.1` = local only) |
| `token` | string | auto | Bootstrap token used to mint short-lived API session tokens |
| `sessionTokenTtl` | number | `300` | Session token lifetime in seconds (60-3600) |
| `rateLimit` | number | `100` | Max requests per minute per IP |
| `pollInterval` | number | `30` | How often (seconds) the plugin checks HomeKit for state changes (10–300) |
| `eventQueueSize` | number | `200` | Max events held in memory; oldest are dropped when full (50–1000) |
| `pluginExternalUrl` | string | `http://localhost:<apiPort>` | URL OpenClaw uses to reach this plugin; used in the `/api/setup` bundle |
| `homebridgeUiUrl` | string | `http://localhost:8581` | Config UI X URL (only if not default) |
| `homebridgeUiUser` | string | auto | UI username (only if auto-detection fails) |
| `homebridgeUiPass` | string | auto | UI password (only if auto-detection fails) |

### Security

**Internal auth (plugin → Config UI X)**
The plugin reads Homebridge internal files (`.uix-secrets` and `auth.json`) to sign valid JWTs. **No username or password is required in `config.json`.**
Only if those files are unavailable (e.g. non-Docker setups), `homebridgeUiUser` / `homebridgeUiPass` are used as fallback.

**Bootstrap token (OpenClaw → plugin)**
Resolved in this order:

1. **Environment variable** `OPENCLAW_HB_TOKEN` — ideal for Docker Compose / Kubernetes.
2. **File** `.openclaw-token` in Homebridge storage — ideal if OpenClaw has filesystem access (same NAS, shared volume).
3. **`token`** in `config.json` — manual fallback.
4. **Auto-generated** — if none of the above exist, a unique token is generated (HMAC of Homebridge secretKey), saved to `.openclaw-token`, and printed in the logs.

Use this token only to call `POST /api/auth/session`. Normal API endpoints now require the returned short-lived session token.

**Rate limiting**
Default: 100 requests per minute per IP. Configurable via `rateLimit`.

### Getting the bootstrap token for OpenClaw

**Option A: Read the file (recommended)**
After first start, the token is in:

```
/var/lib/homebridge/.openclaw-token
```

If using Docker with a mounted volume (e.g. `/Volumes/docker/HomeBridge`):

```bash
cat /Volumes/docker/HomeBridge/.openclaw-token
```

**Option B: Check the logs**
On first start, the bootstrap token is printed in the Homebridge logs:

```
[homebridge-openclaw-gateway] ────────────────────────────────────────
[homebridge-openclaw-gateway] Bootstrap Token: abc123...
[homebridge-openclaw-gateway] Configure this token in your OpenClaw agent.
[homebridge-openclaw-gateway] ────────────────────────────────────────
```

**Option C: Environment variable**
In Docker Compose:

```yaml
environment:
  - OPENCLAW_HB_TOKEN=my-shared-token
```

Configure the same value in OpenClaw.

### REST API

Base URL: `http://<homebridge-ip>:8865`

For local Postman testing outside the Homebridge plugin lifecycle, you can also run the API directly from this repo:

```bash
npm install
OPENCLAW_HB_TOKEN=dev-bootstrap-token npm run dev:api
```

By default the local runner binds to `http://127.0.0.1:8865`. It uses the same Config UI X connection logic as the plugin, so if auto-detection is unavailable set these env vars before starting it:

```bash
export UIX_STORAGE_PATH=/path/to/homebridge/storage
export HOMEBRIDGE_UI_URL=http://127.0.0.1:8581
export HOMEBRIDGE_UI_USER=admin
export HOMEBRIDGE_UI_PASS=admin
```

Optional env vars for local hosting:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCLAW_API_PORT` | `8865` | Local API port |
| `OPENCLAW_API_BIND` | `127.0.0.1` | Bind address for Postman/local-only access |
| `OPENCLAW_HB_TOKEN` | auto | Bootstrap token used to mint session tokens |
| `OPENCLAW_EXTERNAL_URL` | `http://localhost:<port>` | URL embedded into `/api/setup` |
| `OPENCLAW_SESSION_TTL` | `300` | Session token TTL in seconds |
| `OPENCLAW_RATE_LIMIT` | `100` | Requests per minute |
| `OPENCLAW_POLL_INTERVAL` | `30` | Event poll interval in seconds |
| `OPENCLAW_EVENT_QUEUE_SIZE` | `200` | In-memory event buffer size |

Authentication flow:

1. Exchange the bootstrap token for a session token:

```
POST /api/auth/session
Authorization: Bearer <bootstrap-token>
```

2. Use the returned session token on normal API requests:

```
Authorization: Bearer <session-token>
```

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/api/auth/session` | POST | Bootstrap token | Mint a short-lived session token |
| `/api/devices` | GET | Session token | List all devices with current state |
| `/api/devices/type/<type>` | GET | Session token | Filter by type (`switch`, `lightbulb`, etc.) |
| `/api/devices/<id>` | GET | Session token | Single device state |
| `/api/devices/<id>/control` | POST | Session token | Control one device |
| `/api/devices/control` | POST | Session token | Control multiple devices |
| `/api/rooms` | GET | Session token | List learned rooms |
| `/api/rooms/<room>/devices` | GET | Session token | List devices in a learned room |
| `/api/rooms/learn` | POST | Session token | Learn multiple room assignments |
| `/api/devices/<id>/room` | POST | Session token | Assign or update a device room |
| `/api/devices/<id>/room` | DELETE | Session token | Remove a learned device room |
| `/api/events` | GET | Session token | State-change events since a cursor |
| `/api/events/summary` | GET | Session token | Compact summary of events since a cursor |
| `/api/setup` | GET | Bootstrap or session token | OpenClaw self-configuration bundle |

---

**Health (no auth)**

```
GET /health
```

---

**Supported control actions**

| Action | Value | Devices |
|--------|-------|---------|
| `on` / `power` | `true` / `false` | switch, lightbulb, outlet, fan |
| `brightness` / `dim` | 0–100 | lightbulb |
| `hue` | 0–360 | RGB lightbulb |
| `saturation` | 0–100 | RGB lightbulb |
| `color` | `{ "hue": 240, "saturation": 100 }` | RGB lightbulb |
| `colorTemperature` / `ct` | mired | lightbulb |
| `targetTemperature` / `temperature` | 10–35 | thermostat |
| `thermostatMode` / `mode` | `off` / `heat` / `cool` / `auto` | thermostat |
| `lock` | `true` / `false` | lock |
| `speed` / `rotationSpeed` | 0–100 | fan |
| `position` / `targetPosition` | 0–100 | blinds |
| `tilt` / `targetTilt` | -90 to 90 | blinds |
| `garageDoor` / `garage` | `true`=open / `false`=close | garage |

---

**Room learning**

Room assignments are learned metadata stored in Homebridge storage at `.openclaw-rooms.json`. Room matching is case-insensitive.

Device responses include a `room` field once assigned:

```json
{ "id": "xxx", "name": "Desk Lamp", "type": "lightbulb", "room": "Office" }
```

Assign one device to a room:

```
POST /api/devices/<id>/room
{ "room": "Office" }
```

Learn several rooms at once (two formats accepted):

```
POST /api/rooms/learn

{ "devices": [{ "id": "xxx", "room": "Office" }, { "id": "yyy", "room": "Kitchen" }] }
```

```
POST /api/rooms/learn

{ "rooms": { "Office": ["xxx", "zzz"], "Kitchen": ["yyy"] } }
```

### Event Framework

The plugin polls HomeKit internally and maintains a timestamped event queue so OpenClaw can detect state changes without polling the full device list. This dramatically reduces the token cost of staying up to date.

**How it works**

Every `pollInterval` seconds (default 30), the plugin fetches the current state of all accessories from Config UI X and diffs it against the previous snapshot. Any changed characteristics are pushed to an in-memory ring buffer as events with one of three priority levels:

| Priority | Triggers |
|----------|----------|
| `high` | Locks, garage doors, motion sensors, contact sensors |
| `medium` | Thermostats, temperature/humidity sensors |
| `low` | Lights, switches, outlets, fans, blinds |

**Event endpoints**

`GET /api/events?since=<unix_ms>[&priority=high]`

Returns all events newer than the given cursor timestamp. Use the `priority` parameter to filter to high-priority events only.

```json
{
  "cursor": 1745291300000,
  "count": 1,
  "events": [
    {
      "timestamp": 1745291234567,
      "id": "abc123",
      "name": "Garage Door",
      "type": "garage",
      "room": "Garage",
      "priority": "high",
      "changes": { "CurrentDoorState": { "from": 1, "to": 0 } }
    }
  ]
}
```

`GET /api/events/summary?since=<unix_ms>`

Returns a single human-readable summary string. This is the token-efficient path — it is intentionally pre-formatted so the LLM does not need to parse JSON to understand what changed.

```json
{
  "cursor": 1745291300000,
  "has_high_priority": true,
  "summary": "Garage door opened (11:47pm), Hallway motion detected (11:49pm)"
}
```

When nothing has changed, `summary` is an empty string and `has_high_priority` is `false` — a polling skill can exit immediately on this condition, consuming zero LLM tokens.

**Typical OpenClaw polling flow**

```
Every 1 minute (cron):
  GET /api/events/summary?since=<cursor>
  ├── summary empty      → exit silently (0 tokens)
  ├── low priority only  → log summary (minimal tokens)
  └── high priority      → fetch detail, match trigger file, fire session
```

**Setup endpoint**

`GET /api/setup` returns a complete configuration bundle for OpenClaw self-setup, with the plugin URL and bootstrap auth details pre-filled:

```json
{
  "version": "1.0",
  "auth": {
    "bootstrap_endpoint": "http://.../api/auth/session",
    "session_ttl_seconds": 300
  },
  "skills": [{ "name": "homekit-events", "path": "...", "content": "..." }],
  "triggers": [{ "path": "...", "content": "..." }],
  "cron": { "schedule": "* * * * *", "command": "/homekit-events" },
  "claude_md_addition": "...",
  "env": { "OPENCLAW_HB_URL": "http://...", "OPENCLAW_HB_BOOTSTRAP_TOKEN": "..." }
}
```

**One-time OpenClaw setup**

Send this single message to your OpenClaw agent to configure the full event integration:

```
Run /setup-homekit http://<homebridge-ip>:8865 <bootstrap-token>
```

The agent calls `/api/setup`, writes the skill and trigger files under `.openclaw_gateway/`, registers the cron, and updates `CLAUDE.md` — no manual configuration required.

**Event trigger files**

After setup, `.openclaw_gateway/homekit-triggers/` contains instruction files that define what the agent does when a specific HomeKit event fires. Each file has a frontmatter `match` block and a body that becomes the session prompt:

```markdown
---
event: garage_door_open
match:
  type: garage
  characteristic: CurrentDoorState
  to: 0
priority: high
cooldown_minutes: 10
---

The garage door just opened. Check the time, look for correlated sensor
activity, and schedule a follow-up if the door is left open.
```

Add a new trigger by dropping a `.md` file into `.openclaw_gateway/homekit-triggers/` — no code changes needed.
If you include `match.device_name`, the trigger only fires for that exact HomeKit device name; otherwise it matches on event shape alone.

### Using from OpenClaw

Example with `curl`:

```bash
SESSION_TOKEN=$(curl -s -X POST \
  -H "Authorization: Bearer BOOTSTRAP_TOKEN" \
  http://HOMEBRIDGE_IP:8865/api/auth/session | jq -r '.access_token')

# List devices
curl -s -H "Authorization: Bearer $SESSION_TOKEN" http://HOMEBRIDGE_IP:8865/api/devices

# Turn on a light
curl -s -X POST \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"on","value":true}' \
  http://HOMEBRIDGE_IP:8865/api/devices/DEVICE_ID/control

# Check for events since a cursor
curl -s -H "Authorization: Bearer $SESSION_TOKEN" \
  "http://HOMEBRIDGE_IP:8865/api/events/summary?since=1745291000000"
```

### Acknowledgements

This plugin is based on [homebridge-openclaw-gateway](https://github.com/davidevp/homebridge-openclaw) by [Davide Vargas P.](https://github.com/davidevp), whose original work established the REST API design and Homebridge integration. The event framework, OpenClaw self-setup system, and multi-module architecture are extensions by [Robert Day](https://github.com/dayrobert).

### License

MIT — see [LICENSE](LICENSE). Original copyright Davide Vargas P.; extensions copyright Robert Day.
