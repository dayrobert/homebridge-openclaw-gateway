# HomeKit Event Framework Design

## Overview

This document describes the design for a bidirectional event framework that allows state changes detected in HomeKit to trigger OpenClaw agent sessions — while minimizing LLM token consumption.

The current plugin architecture is entirely pull-based: OpenClaw must query `/api/devices` to discover any state changes. This burns tokens on every poll even when nothing has changed. The event framework replaces this with a push-on-change model where the plugin detects diffs internally and OpenClaw only pays token cost when meaningful events occur.

---

## Design Goals

- Detect HomeKit state changes without requiring OpenClaw to poll
- Minimize LLM token usage (target: zero tokens when nothing has changed)
- Allow event-specific agent sessions with pre-loaded, targeted instructions
- Be self-describing: the plugin should tell OpenClaw how to configure itself
- Remain extensible: adding a new event trigger requires no code changes

---

## Architecture: Three-Layer Token Guard

```
Layer 1 — Plugin polls HomeKit internally (not OpenClaw)
Layer 2 — OpenClaw queries a diff-only endpoint (small payload)
Layer 3 — Skill short-circuits if no meaningful events exist (zero LLM tokens)
```

Each layer filters further, so LLM context is only consumed when something worth acting on has actually happened.

---

## Component 1: Plugin — Internal State Poller and Event Queue

### State Poller

A `setInterval` loop started in `_startServer()` on `didFinishLaunching`. It calls `uiClient.getAccessories()` on a configurable interval (default 30 seconds), diffs the result against the previous snapshot, and pushes any changes to an in-memory event queue.

The plugin polls Config UI X — OpenClaw does not. This keeps the upstream traffic local and avoids OpenClaw needing direct network access to Homebridge.

### Event Queue

A capped ring buffer (default 200 events). Each entry:

```json
{
  "timestamp": 1745291234567,
  "id": "abc123",
  "name": "Garage Door",
  "type": "garage",
  "room": "Garage",
  "changes": {
    "CurrentDoorState": { "from": 1, "to": 0 }
  },
  "priority": "high"
}
```

### Priority Classification

Priority is assigned by the plugin, not the LLM. This is the primary token guard — low-priority events never enter the LLM context unless explicitly requested.

| Priority | Device types / characteristics |
|----------|-------------------------------|
| `high`   | `lock`, `garage`, motion sensors (`MotionDetected`), contact sensors (`ContactSensorState`) |
| `medium` | `thermostat`, sensors outside a normal range |
| `low`    | `lightbulb`, `switch`, `outlet`, `fan`, `blinds` |

### New Configuration Fields

```json
{
  "pollInterval": 30,
  "eventQueueSize": 200
}
```

---

## Component 2: Plugin — New API Endpoints

### `GET /api/events`

Returns all events since a given cursor. Query parameters:

- `since` — Unix timestamp in milliseconds (required)
- `priority` — filter to `high`, `medium`, or `low` (optional)

```json
{
  "cursor": 1745291300000,
  "count": 1,
  "events": [
    {
      "timestamp": 1745291234567,
      "name": "Garage Door",
      "type": "garage",
      "room": "Garage",
      "priority": "high",
      "changes": { "CurrentDoorState": { "from": 1, "to": 0 } }
    }
  ]
}
```

### `GET /api/events/summary`

Returns a single pre-formatted string — the minimum the LLM needs to understand what happened. No JSON parsing required. This is the primary token-efficient path for the skill.

```json
{
  "cursor": 1745291300000,
  "has_high_priority": true,
  "summary": "Garage door opened (11:47pm), Hallway motion detected (11:49pm)"
}
```

When nothing has changed:

```json
{ "cursor": 1745291300000, "has_high_priority": false, "summary": "" }
```

---

## Component 3: Plugin — Setup Endpoint

### `GET /api/setup`

A self-describing endpoint that returns everything an OpenClaw agent needs to configure itself. Content is rendered server-side with the real plugin URL and token substituted in, so the agent never needs to manually edit configuration values.

```json
{
  "version": "1.0",
  "plugin": "homebridge-openclaw-gateway",
  "skills": [
    {
      "name": "homekit-events",
      "path": ".openclaw_gateway/commands/homekit-events.md",
      "content": "..."
    }
  ],
  "triggers": [
    {
      "path": ".openclaw_gateway/homekit-triggers/garage-door-open.md",
      "content": "..."
    }
  ],
  "cron": {
    "schedule": "* * * * *",
    "command": "/homekit-events",
    "description": "Poll HomeKit for state changes every minute"
  },
  "claude_md_addition": "...",
  "env": {
    "OPENCLAW_HB_URL": "http://192.168.1.10:8899",
    "OPENCLAW_HB_TOKEN": "<token>"
  }
}
```

---

## Component 4: OpenClaw Skill — `homekit-events`

A skill file at `.openclaw_gateway/commands/homekit-events.md`. Responsible for the recurring lightweight check.

### Execution steps

1. Read the last cursor timestamp from `.openclaw_gateway/homekit-triggers/.cursor` (default: 30 minutes ago if file missing)
2. Call `GET /api/events/summary?since=<cursor>`
3. Write the returned `cursor` value back to `.openclaw_gateway/homekit-triggers/.cursor`
4. If `summary` is empty — exit silently (zero LLM tokens consumed)
5. If `has_high_priority` is false — log the summary only (no LLM escalation)
6. If `has_high_priority` is true:
   - Match each event against trigger files in `.openclaw_gateway/homekit-triggers/`
   - Required match keys: `type`, `characteristic`, `to`
   - Optional strict key: `device_name` must equal the event's device name when present
   - For matched triggers: check cooldown, then fire `RemoteTrigger`
   - Fetch full event detail via `GET /api/events?priority=high&since=<cursor>` for the session context

### Token cost by scenario

| Scenario | Token cost |
|----------|-----------|
| Nothing changed | 0 tokens (skill exits before LLM reads) |
| Low-priority only (lights toggled) | ~30 tokens (compact summary logged) |
| High-priority, no trigger file | ~50 tokens (summary surfaced) |
| High-priority with trigger file | ~150 tokens (summary + event detail for session context) |

---

## Component 5: OpenClaw Cron

The skill is registered as a scheduled remote agent running every minute:

```
/schedule every minute run /homekit-events
```

A separate daily digest cron surfaces low-priority activity in aggregate:

```
/schedule every day at 9am run /homekit-events --digest
```

In `--digest` mode, the skill fetches all events since the previous digest and produces a one-paragraph summary of home activity without triggering individual sessions.

---

## Component 6: Event-Triggered Sessions

### Trigger Definition Files

Each HomeKit event type that should launch a dedicated session gets its own file at `.openclaw_gateway/homekit-triggers/<event-name>.md`. Adding a new trigger type requires no code changes.

**Frontmatter** is machine-readable by the `homekit-events` skill:

```yaml
---
event: garage_door_open
match:
  type: garage
  characteristic: CurrentDoorState
  to: 0
  # Optional: constrain the trigger to one exact HomeKit device name
  device_name: Garage Door
priority: high
cooldown_minutes: 10
---
```

**Body** is the session instructions injected verbatim into the new agent session:

```markdown
The garage door just opened. Event details are injected below.

1. Check the current time. If between 10pm and 7am, this is unusual — flag it.
2. Query recent high-priority events for correlated sensor activity.
3. If motion sensors also fired within 5 minutes, treat as a potential security situation.
4. If the door is still open in 30 minutes, remind me to close it.
5. Log a one-line summary and your assessment.
```

### Session Context Injection

When `RemoteTrigger` fires, the new session receives a composed prompt:

```
## HomeKit Event: Garage Door Opened

- Device: Garage Door (Garage)
- Time: 2026-04-21 11:47pm
- Change: CurrentDoorState 1 → 0 (opened)
- Other recent high-priority events: none in last 15 min

---
[trigger file body]
```

The session has full access to the plugin REST API and can query other device states, correlate events, issue controls, or schedule follow-up tasks.

### Cooldown

A cooldown file at `.openclaw_gateway/homekit-triggers/.cooldowns.json` tracks the last-fired timestamp per trigger. If `now - last_fired < cooldown_minutes`, the trigger is skipped. This prevents a flapping sensor from spawning repeated sessions.

```json
{
  "garage_door_open": 1745291234567,
  "front_door_unlock": 1745288000000
}
```

---

## Setup Flow

The one-time setup uses the plugin's `/setup-homekit` bootstrap skill, which:

1. Calls `GET /api/setup` with the plugin URL and token
2. Writes all skill files and trigger files to their correct paths
3. Updates `CLAUDE.md` with the integration description block
4. Registers the cron via `/schedule`
5. Writes env vars to settings

The user sends one message to their OpenClaw session:

```
Run /setup-homekit http://homebridge.local:8899 <token>
```

---

## Complete Data Flow

```
HomeKit physical change (e.g. garage door opens)
    ↓ (Homebridge sees it immediately)
Config UI X internal state
    ↓ (plugin internal poll, every 30s — max detection latency)
Plugin state differ
    ↓ (detects CurrentDoorState 1→0)
EventQueue.push({ name, type, changes, priority: "high", timestamp })
    ↓
GET /api/events/summary?since=<cursor>    ← OpenClaw cron (every 1 min)
    ↓
homekit-events skill
    ├─→ summary empty         → exit (0 tokens)
    ├─→ low priority only     → log (30 tokens)
    └─→ high priority found
            ↓
        match .openclaw_gateway/homekit-triggers/garage-door-open.md
            ↓
        cooldown clear?
            ├─→ no  → skip
            └─→ yes → RemoteTrigger fires new session
                            ↓
                    New Claude Code session:
                    - Event context (device, time, state change)
                    - Trigger file instructions
                    - Full API access for correlated queries,
                      controls, and follow-up scheduling
```

---

## Self-Describing Setup Flow

```
User: "Run /setup-homekit http://homebridge.local:8899 <token>"
    ↓
/setup-homekit skill calls GET /api/setup
    ↓
Plugin returns rendered bundle (skill content, trigger files, cron config, CLAUDE.md block)
    ↓
Skill writes:
    .openclaw_gateway/commands/homekit-events.md
    .openclaw_gateway/homekit-triggers/garage-door-open.md
    .openclaw_gateway/homekit-triggers/.cooldowns.json  (empty)
    CLAUDE.md  (appends integration block)
    ↓
Skill registers cron: /schedule every minute run /homekit-events
    ↓
Setup complete. Integration is live within 30s of next garage state change.
```

---

## Token Budget Summary

| Scenario | Before (polling `/api/devices`) | After (event framework) |
|----------|---------------------------------|-------------------------|
| 1-min poll, nothing changed | ~1,500 tokens | 0 tokens |
| Light toggled manually | ~1,500 tokens | ~30 tokens |
| Garage door opened | ~1,500 tokens | ~150 tokens |
| Morning activity digest | N/A | ~200 tokens (once daily) |
| Per-hour cost (idle home) | ~90,000 tokens/hr | 0 tokens/hr |

---

## Implementation Sequence

| Step | Component | Scope |
|------|-----------|-------|
| 1 | `EventQueue` class + state poller `setInterval` | `index.js` |
| 2 | Priority classifier (`classifyPriority`) | `index.js` |
| 3 | `GET /api/events` and `GET /api/events/summary` endpoints | `index.js` |
| 4 | `GET /api/setup` endpoint (renders skill/trigger/cron bundle) | `index.js` |
| 5 | `pollInterval`, `eventQueueSize` config fields | `config.schema.json` |
| 6 | `.openclaw_gateway/commands/homekit-events.md` skill definition | OpenClaw project |
| 7 | `.openclaw_gateway/homekit-triggers/garage-door-open.md` (and other templates) | OpenClaw project |
| 8 | `/setup-homekit` bootstrap skill | OpenClaw project |
| 9 | Cron registration via `/schedule` | OpenClaw session (one-time) |

Steps 1–5 are changes to this plugin. Steps 6–9 are delivered to the OpenClaw project via the `/api/setup` endpoint and bootstrap skill — no manual configuration required.
