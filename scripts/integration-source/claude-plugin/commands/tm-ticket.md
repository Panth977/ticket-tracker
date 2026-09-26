---
description: One TaskManager ticket in full — fields, thread, task list, files, links
argument-hint: <KEY> (e.g. ENG-42)
allowed-tools: mcp__taskmanager__get_ticket, mcp__taskmanager__get_messages, mcp__taskmanager__read_file, mcp__taskmanager__get_question, mcp__taskmanager__get_board
---

Show me ticket `$1` in full.

1. `get_ticket` for `$1` — a key names its own board, so no board argument is needed.
2. `get_messages` for the thread. Read all of it; summarise, do not paste it back at me.
3. Lay it out:

   ```text
   KEY · title                    stage · priority · state
   who                            assignees, watchers
   when                           created / updated / due, and whether that is late
   what it is                     the description, in your own words if it is long
   the story                      what the thread says happened, in order, dated
   the plan                       the task list, with what is done and what is not
   open                           unanswered questions, blocking links, unread-by-me messages
   files                          attachments worth opening, by name
   ```

4. Finish with **where it actually stands** and the next action — one sentence each. If it is waiting on a
   person, say which person and for what.

Read files with `read_file` only when the thread says the answer is inside one.
