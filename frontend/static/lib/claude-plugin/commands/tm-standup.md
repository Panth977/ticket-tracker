---
description: What moved and what is stuck since yesterday, across your boards
argument-hint: [board] [since, e.g. yesterday / 3d]
allowed-tools: mcp__taskmanager__list_boards, mcp__taskmanager__get_board, mcp__taskmanager__search_tickets, mcp__taskmanager__list_my_tickets, mcp__taskmanager__get_ticket, mcp__taskmanager__get_messages, mcp__taskmanager__get_events
---

Write my standup for $1 (a board key, or every board I am on when I leave it out), covering $2 (default: since
yesterday).

1. `list_boards` unless I named one. For each board in scope, find what changed in the window: tickets that
   moved stage, tickets that were created or closed, threads with new messages, task lists that progressed.
2. Report it the way a standup is spoken, three sections, no filler:

   ```text
   moved        KEY · title · from → to · who
   in flight    KEY · title · what the last message actually says · how long it has sat there
   stuck        KEY · title · what it is waiting on (a question, a blocking ticket, a person)
   ```

3. Put what is **stuck** first if anything is waiting on me.
4. Two closing lines: what got finished, and the one thing most at risk today.

Facts only — every line comes from a ticket or a message you read, and carries its key. If nothing moved on a
board, say so in one line rather than padding it.
