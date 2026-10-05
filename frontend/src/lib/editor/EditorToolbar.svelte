<!--
  Formatting bar for a RichEditor: B I S </> Link • 1. ☐ ❝ (📎 when onattach,
  ❓ when onask — the composer's 'Ask a question', §N1; 🧠 when onmemory —
  'Attach from memory', memory.html §E).
  <EditorToolbar {editor} onattach={() => fileInput.click()} onask={() => (askOpen = true)} />
-->
<script lang="ts">
  import type { Editor } from '@tiptap/core';
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
    /** memory.html §E: attach files from a memory granted to this board. */
    onmemory?: () => void;
    /** aggregates.html: 'Add to a total' — shown when the board has active aggregate fields. */
    onagg?: () => void;
    disabled?: boolean;
    class?: string;
  }
  let {
    editor,
    onattach,
    onask,
    onmemory,
    onagg,
    disabled = false,
    class: cls = '',
  }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const e = editor;
    if (!e) return;
    const bump = () => (tick += 1);
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
    />
    {#if t.id === 'link' || t.id === 'code'}<span class="mx-0.5 h-4 w-px bg-line" aria-hidden="true"
      ></span>{/if}
  {/each}
  {#if onattach || onask || onmemory || onagg}
    <span class="mx-0.5 h-4 w-px bg-line" aria-hidden="true"></span>
  {/if}
  {#if onattach}
    <IconButton icon={Paperclip} label="Attach files" size="sm" {disabled} onclick={onattach} />
  {/if}
  {#if onmemory}
    <IconButton icon={Brain} label="Attach from memory" size="sm" {disabled} onclick={onmemory} />
  {/if}
  {#if onask}
    <IconButton icon={CircleHelp} label="Ask a question" size="sm" {disabled} onclick={onask} />
  {/if}
  {#if onagg}
    <IconButton icon={Sigma} label="Add to a total" size="sm" {disabled} onclick={onagg} />
  {/if}
</div>
