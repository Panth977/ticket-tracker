---
description: Create a TaskManager ticket from a sentence, on the board you name
argument-hint: <board> <title…>
allowed-tools: mcp__taskmanager__list_boards, mcp__taskmanager__get_board, mcp__taskmanager__search_tickets, mcp__taskmanager__create_ticket, mcp__taskmanager__get_ticket
---

Create a ticket on board `$1` titled: $ARGUMENTS (everything after the board key).

1. `get_board` for `$1` — its stages, priorities, tags and required custom fields.
2. `search_tickets` for the same words first. If something close already exists, show it and ask whether to add
   to that thread instead of opening a second ticket.
3. Write it properly:
   - **title**: one line, the thing itself, no ticket-speak
   - **description**: Markdown — what this is, why now, and what "done" looks like. Use what we have been
     talking about in this session; do not pad it with invented detail.
   - **tags / priority / fields**: only values this board actually has. Fill what a stage's `requires` demands.
4. Create it (it lands in the board's first stage), then show the new key and title.

If `$1` is not a board key I can reach, call `list_boards` and ask which one I meant — do not pick for me.
