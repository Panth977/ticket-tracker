<!--
  Formatting bar for a RichEditor: B I S </> Link • 1. ☐ ❝ (📎 when onattach,
  ❓ when onask — the composer's 'Ask a question', §N1; 🧠 when onbucket —
  'Attach from bucket', bucket.html §E; 📋 when ontemplate — the board's
  message templates, templates.html §D1).
  `collapsible` (the composer): on a phone only the actions show (📎 🧠 ❓ Σ 📋)
  and a › button unfolds the formatting tools.
  <EditorToolbar {editor} onattach={() => fileInput.click()} onask={() => (askOpen = true)} />
-->
<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import { untrack } from 'svelte';
  import {
    Bold,
    CircleHelp,
    Code,
    Italic,
    Link as LinkIcon,
    List,
    ListChecks,
    ListOrdered,
    Paperclip,
    Brain,
    ChevronLeft,
    ChevronRight,
    ClipboardList,
    Quote,
    Sigma,
    Strikethrough,
  } from 'lucide-svelte';
  import { isAllowedHref } from '@tm/shared/logic/index';
  import IconButton from '$lib/ui/IconButton.svelte';
  import type { IconComponent } from '$lib/ui/types';

  interface Props {
    editor: Editor | null;
    onattach?: () => void;
    /** Phase 5 (§N1): 'Ask a question' — shown to anyone who may comment. */
    onask?: () => void;
    /** bucket.html §E: attach files from a bucket granted to this board. */
    onbucket?: () => void;
    /** aggregates.html: 'Add to a total' — shown when the board has active aggregate fields. */
    onagg?: () => void;
    /** templates.html §D1: 'Use a template' — shown when the board has message templates. */
    ontemplate?: () => void;
    disabled?: boolean;
    /** On a phone, hide the formatting tools behind a › toggle (the composer). */
    collapsible?: boolean;
    class?: string;
  }
  let {
    editor,
    onattach,
    onask,
    onbucket,
    onagg,
    ontemplate,
    disabled = false,
    collapsible = false,
    class: cls = '',
  }: Props = $props();

  /** Phone only: the formatting tools are unfolded. */
  let expanded = $state(false);
  const fold = $derived(collapsible && !expanded ? 'max-sm:hidden' : '');

  let tick = $state(0);
  $effect(() => {
    const e = editor;
    if (!e) return;
    // A transaction can fire inside someone else's effect (a command run from
    // one): reading `tick` there would make that effect depend on it and run
    // again on every bump — an endless loop. Read it untracked.
    const bump = () => (tick = untrack(() => tick) + 1);
    e.on('transaction', bump);
    return () => {
      e.off('transaction', bump);
    };
  });

  interface Tool {
    id: string;
    label: string;
    icon: IconComponent;
    active: (e: Editor) => boolean;
    run: (e: Editor) => void;
  }
  const tools: Tool[] = [
    {
      id: 'bold',
      label: 'Bold (⌘B)',
      icon: Bold,
      active: (e) => e.isActive('bold'),
      run: (e) => e.chain().focus().toggleBold().run(),
    },
    {
      id: 'italic',
      label: 'Italic (⌘I)',
      icon: Italic,
      active: (e) => e.isActive('italic'),
      run: (e) => e.chain().focus().toggleItalic().run(),
    },
    {
      id: 'strike',
      label: 'Strikethrough',
      icon: Strikethrough,
      active: (e) => e.isActive('strike'),
      run: (e) => e.chain().focus().toggleStrike().run(),
    },
    {
      id: 'code',
      label: 'Code',
      icon: Code,
      active: (e) => e.isActive('code') || e.isActive('codeBlock'),
      run: (e) => e.chain().focus().toggleCode().run(),
    },
    { id: 'link', label: 'Link', icon: LinkIcon, active: (e) => e.isActive('link'), run: link },
    {
      id: 'bullet',
      label: 'Bulleted list',
      icon: List,
      active: (e) => e.isActive('bulletList'),
      run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    {
      id: 'ordered',
      label: 'Numbered list',
      icon: ListOrdered,
      active: (e) => e.isActive('orderedList'),
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    {
      id: 'task',
      label: 'Checklist',
      icon: ListChecks,
      active: (e) => e.isActive('taskList'),
      run: (e) => e.chain().focus().toggleTaskList().run(),
    },
    {
      id: 'quote',
      label: 'Quote',
      icon: Quote,
      active: (e) => e.isActive('blockquote'),
      run: (e) => e.chain().focus().toggleBlockquote().run(),
    },
  ];

  function link(e: Editor) {
    if (e.isActive('link')) {
      e.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const prev = (e.getAttributes('link').href as string | undefined) ?? 'https://';
    const href = window.prompt('Link address (https:// or mailto:)', prev)?.trim();
    if (!href) return;
    if (!isAllowedHref(href)) {
      window.alert('Only https://, http:// and mailto: links are allowed.');
      return;
    }
    if (e.state.selection.empty) {
      e.chain()
        .focus()
        .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
        .run();
    } else e.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }

  const active = $derived.by(() => {
    void tick;
    const e = editor;
    return Object.fromEntries(tools.map((t) => [t.id, !!e && t.active(e)]));
  });
</script>

<div class="flex flex-wrap items-center gap-0.5 {cls}" role="toolbar" aria-label="Formatting">
  {#each tools as t (t.id)}
    <IconButton
      icon={t.icon}
      label={t.label}
      size="sm"
      active={active[t.id]}
      disabled={disabled || !editor}
      onmousedown={(ev: MouseEvent) => ev.preventDefault()}
      onclick={() => editor && t.run(editor)}
      class={fold}
    />
    {#if t.id === 'link' || t.id === 'code'}<span
        class="mx-0.5 h-4 w-px bg-line {fold}"
        aria-hidden="true"
      ></span>{/if}
  {/each}
  {#if onattach || onask || onbucket || onagg || ontemplate}
    <span class="mx-0.5 h-4 w-px bg-line {fold}" aria-hidden="true"></span>
  {/if}
  {#if onattach}
    <IconButton icon={Paperclip} label="Attach files" size="sm" {disabled} onclick={onattach} />
  {/if}
  {#if onbucket}
    <IconButton icon={Brain} label="Attach from bucket" size="sm" {disabled} onclick={onbucket} />
  {/if}
  {#if onask}
    <IconButton icon={CircleHelp} label="Ask a question" size="sm" {disabled} onclick={onask} />
  {/if}
  {#if onagg}
    <IconButton icon={Sigma} label="Add to a total" size="sm" {disabled} onclick={onagg} />
  {/if}
  {#if ontemplate}
    <IconButton
      icon={ClipboardList}
      label="Use a template"
      size="sm"
      {disabled}
      onclick={ontemplate}
    />
  {/if}
  {#if collapsible}
    <IconButton
      icon={expanded ? ChevronLeft : ChevronRight}
      label={expanded ? 'Hide formatting' : 'Show formatting'}
      size="sm"
      aria-expanded={expanded}
      onmousedown={(ev: MouseEvent) => ev.preventDefault()}
      onclick={() => (expanded = !expanded)}
      class="ml-auto sm:hidden"
    />
  {/if}
</div>
