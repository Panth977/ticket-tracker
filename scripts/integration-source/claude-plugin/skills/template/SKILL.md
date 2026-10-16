---
name: template
description: How to write a TaskManager board TEMPLATE — a few lines of JavaScript that shape a board's own UI: a message template (a form in the composer whose submit posts a message), a ticket template (a form in New ticket whose submit creates a ticket) or a card template (what each kanban card shows). Use whenever the user asks for a form, a message or ticket template, "a bug report form", dependent dropdowns, a custom card or card preview on a TaskManager board, or mentions template_save, list_templates or cardTemplateId.
---

# TaskManager templates

Version {{VERSION}} · updated {{UPDATED}} · this deployment: {{HOST}}

The steps, every time:

```text
1. read      get_template_docs (this text + a starter per kind) and list_templates { include_code: true }
             — change an existing template rather than adding a near-copy
2. look      get_board_settings: the stages, priorities, tags and custom fields to name (by name is fine)
3. write     template_save { board, template: { kind, name, description, code } }
             — templateId to update one; a template keeps its kind; only board admins may
4. use it    card templates: view_save with view.cardTemplateId on a kanban view
5. tell      the person where it shows: the composer's 📋, New ticket, or the view — and that
             Settings › Templates has a live preview where they can try it
```

Write `description` for people and agents ("Steps, severity and environment for a bug"). Keep the code
small and readable — the board's admins maintain it after you.

The full reference — also §9 of `../taskmanager/reference/llms-full.txt`, live at {{url:llmsFullUrl}}:

{{gen:templates}}
