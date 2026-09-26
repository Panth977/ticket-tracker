---
description: One pass over a board's untriaged tickets — propose stage, priority, tags and assignee
argument-hint: <board> [how many]
allowed-tools: mcp__taskmanager__list_boards, mcp__taskmanager__get_board, mcp__taskmanager__search_tickets, mcp__taskmanager__get_ticket, mcp__taskmanager__get_messages, mcp__taskmanager__update_ticket, mcp__taskmanager__move_ticket, mcp__taskmanager__assign_ticket
---

Triage the board `$1`. Look at at most $2 tickets (default 15).

1. `get_board` for `$1` so you know its real stages, priorities, tags, custom fields and members. Never invent
   any of them — a stage that does not exist on this board is a failed call.
2. Find what is untriaged: tickets in the first stage, or with no priority, no tags or no assignee. Oldest
   first — the ones that have been ignored longest.
3. For each one, read the ticket and enough of its thread to know what it is really about, then propose, in one
   line each:

   ```text
   KEY · title
     → stage / priority / tags / assignee, and the one-clause reason
     → duplicate of KEY, if `search_tickets` says it is
     → what is missing, if it cannot be triaged as written
   ```

4. Show me the whole list **before changing anything**. Then apply exactly what I approve, one call per ticket,
   and report what changed.

If a ticket is too thin to triage, say what question would fix it rather than guessing a priority.
