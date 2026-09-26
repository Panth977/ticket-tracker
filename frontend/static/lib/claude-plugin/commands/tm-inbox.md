---
description: What TaskManager is waiting on you for — assignments, mentions, answered questions
allowed-tools: mcp__taskmanager__get_events, mcp__taskmanager__list_boards, mcp__taskmanager__list_my_tickets, mcp__taskmanager__get_ticket, mcp__taskmanager__ack_events
---

Show me what is waiting on me in TaskManager.

1. `get_events` for the unacknowledged events. If the credential spans several boards, `list_boards` first and
   cover all of them.
2. `list_my_tickets` for what is assigned to me and still active.
3. Group what you found by what it asks of me, most urgent first:
   - **answer this** — questions waiting on me, and `question_answered` events I have not acted on
   - **you were given this** — `assigned` / `mentioned`, newest first
   - **moving without me** — `comment`, `stage`, `updated` on tickets I am on
   - **late** — anything overdue or due today
4. One line per item: `KEY · title · what changed · who · when`. Keep it scannable; no preamble.
5. End with the single thing you would do first, and why.

Do **not** `ack_events` unless I ask — acknowledging is me saying I have dealt with it, not you saying you have
read it.
