'use strict';

const { PLUGIN_NAME } = require('./constants');

function buildSkillContent(url, sessionTtlSeconds) {
  return `# homekit-events

Poll the homebridge-openclaw-gateway plugin for HomeKit state changes and dispatch event-triggered sessions.

## Steps

1. Exchange the bootstrap token for a short-lived session token:
   \`\`\`
   POST ${url}/api/auth/session
   Authorization: Bearer \${OPENCLAW_HB_BOOTSTRAP_TOKEN}
   \`\`\`
   Save the returned \`access_token\` and use it as the Bearer token for the rest of this run. The session token expires after ${sessionTtlSeconds} seconds.

2. Read the last cursor from \`.openclaw_gateway/homekit-triggers/.cursor\`. If the file does not exist, use a timestamp from 30 minutes ago as the starting point.

3. Fetch the events summary:
   \`\`\`
   GET ${url}/api/events/summary?since=<cursor>
   Authorization: Bearer <session_token>
   \`\`\`

4. Write the returned \`cursor\` value to \`.openclaw_gateway/homekit-triggers/.cursor\`.

5. If \`summary\` is empty — output nothing and stop.

6. If \`has_high_priority\` is false — log the summary as a brief note and stop.

7. If \`has_high_priority\` is true:
   - Fetch full event detail:
     \`\`\`
     GET ${url}/api/events?priority=high&since=<cursor>
     Authorization: Bearer <session_token>
     \`\`\`
   - Read all \`.md\` files in \`.openclaw_gateway/homekit-triggers/\`
   - For each high-priority event, find a trigger file whose frontmatter \`match\` block matches on \`type\`, \`characteristic\`, and \`to\` value
   - If the trigger's \`match\` block also includes \`device_name\`, require it to equal the event's device name before treating it as a match
   - Read \`.openclaw_gateway/homekit-triggers/.cooldowns.json\` (treat as \`{}\` if missing)
   - For each matched trigger: skip if \`now - last_fired < cooldown_minutes * 60000\`
   - For triggers that pass the cooldown check: fire RemoteTrigger with the composed prompt below, then update \`.openclaw_gateway/homekit-triggers/.cooldowns.json\`

## Composed prompt format for RemoteTrigger

\`\`\`
## HomeKit Event: <human-readable event description>

- Device: <device name> (<room if known>)
- Time: <formatted timestamp>
- Change: <characteristic> <from> → <to>
- Other recent high-priority events: <list or "none in last 15 min">

---
<trigger file body verbatim>
\`\`\`
`;
}

function buildGarageTriggerContent(url, sessionTtlSeconds) {
  return `---
event: garage_door_open
match:
  type: garage
  characteristic: CurrentDoorState
  to: 0
priority: high
cooldown_minutes: 10
---

The garage door just opened. The event details are injected above.

## Your job for this session

1. Check the current time. If it is between 10pm and 7am, flag this as unusual timing.

2. Check for correlated sensor activity in the last 15 minutes:
   \`\`\`
   GET ${url}/api/events?priority=high&since=<15 minutes ago as unix ms>
   Authorization: Bearer <session_token>
   \`\`\`

3. If any motion sensors or contact sensors also fired within 5 minutes of this event, treat it as a potential security situation and escalate prominently.

4. Check whether the garage door is still open:
   \`\`\`
   GET ${url}/api/devices/<device-id>
   Authorization: Bearer <session_token>
   \`\`\`

5. If the door is still open and no security concerns exist, schedule a follow-up reminder in 30 minutes.

6. If the session token has expired, mint a fresh one first. Session TTL: ${sessionTtlSeconds} seconds.

7. Log a one-line summary and your assessment of the situation.
`;
}

function buildClaudeMdAddition(url) {
  return `
## HomeKit Integration (${PLUGIN_NAME})

A scheduled cron runs \`/homekit-events\` every minute to detect HomeKit state changes.

- Plugin API: ${url}
- High-priority events (locks, garage, motion sensors) trigger dedicated agent sessions
- Event-specific instructions live in \`.openclaw_gateway/homekit-triggers/\`
- Cursor state: \`.openclaw_gateway/homekit-triggers/.cursor\`
- Cooldown state: \`.openclaw_gateway/homekit-triggers/.cooldowns.json\`

Do not delete files in \`.openclaw_gateway/homekit-triggers/\` — they define how the agent responds to HomeKit events.
To add a new event trigger, create a new \`.md\` file in that directory following the frontmatter format of existing files.
Use \`match.device_name\` when a trigger should only fire for one specific HomeKit device.
`;
}

module.exports = { buildSkillContent, buildGarageTriggerContent, buildClaudeMdAddition };
