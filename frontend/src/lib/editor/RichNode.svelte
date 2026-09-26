<!--
  One node of a stored rich-text doc, rendered as Svelte (never {@html}): only
  the allow-listed nodes and marks exist, links are re-checked, a mention shows
  the person's CURRENT name, a #ref links to the ticket by key.
-->
<script lang="ts">
  // Ticket links come from ctx.ticketHref (lib/layout/routes); other hrefs are external. The SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { PMMark, PMNode } from '@tm/shared';
  import { isAllowedHref } from '@tm/shared/logic/index';
  import MentionName from './MentionName.svelte';
  import CodeBlock from './CodeBlock.svelte';
  import RichNode from './RichNode.svelte';

  interface Props {
    node: PMNode;
    ticketHref?: (key: string, ticketId: string) => string;
  }
  let { node, ticketHref }: Props = $props();

  const kids = $derived(node.content ?? []);
  const refKey = $derived(
    typeof node.attrs?.key === 'string' && node.attrs.key ? node.attrs.key : null,
  );
</script>

{#snippet children()}
  {#each kids as c, i (i)}<RichNode node={c} {ticketHref} />{/each}
{/snippet}

{#snippet marked(text: string, marks: PMMark[])}
  {#if marks.length === 0}{text}{:else}
    {@const m = marks[0]!}
    {@const rest = marks.slice(1)}
    {#if m.type === 'bold'}<strong>{@render marked(text, rest)}</strong>
    {:else if m.type === 'italic'}<em>{@render marked(text, rest)}</em>
    {:else if m.type === 'strike'}<s>{@render marked(text, rest)}</s>
    {:else if m.type === 'underline'}<u>{@render marked(text, rest)}</u>
    {:else if m.type === 'code'}<code>{@render marked(text, rest)}</code>
    {:else if m.type === 'link' && isAllowedHref(m.attrs?.href)}
      <a href={String(m.attrs?.href)} target="_blank" rel="noopener noreferrer nofollow"
        >{@render marked(text, rest)}</a
      >
    {:else}{@render marked(text, rest)}{/if}
  {/if}
{/snippet}

{#if node.type === 'text'}
  {@render marked(node.text ?? '', node.marks ?? [])}
{:else if node.type === 'paragraph'}
  <p>{@render children()}</p>
{:else if node.type === 'heading'}
  {@const level = Number(node.attrs?.level ?? 1)}
  {#if level === 1}<h1>{@render children()}</h1>{:else if level === 2}<h2>
      {@render children()}
    </h2>{:else}<h3>{@render children()}</h3>{/if}
{:else if node.type === 'blockquote'}
  <blockquote>{@render children()}</blockquote>
{:else if node.type === 'bulletList'}
  <ul>{@render children()}</ul>
{:else if node.type === 'orderedList'}
  <ol start={Number(node.attrs?.start ?? 1)}>{@render children()}</ol>
{:else if node.type === 'listItem'}
  <li>{@render children()}</li>
{:else if node.type === 'taskList'}
  <ul data-type="taskList">{@render children()}</ul>
{:else if node.type === 'taskItem'}
  <li data-checked={node.attrs?.checked === true}>
    <label
      ><input
        type="checkbox"
        checked={node.attrs?.checked === true}
        disabled
        aria-label="Checklist item"
      /></label
    >
    <div>{@render children()}</div>
  </li>
{:else if node.type === 'codeBlock'}
  <CodeBlock
    code={kids.map((k) => k.text ?? '').join('')}
    language={typeof node.attrs?.language === 'string' ? node.attrs.language : null}
  />
{:else if node.type === 'horizontalRule'}
  <hr />
{:else if node.type === 'hardBreak'}
  <br />
{:else if node.type === 'mention'}
  <span class="mention"><MentionName uid={String(node.attrs?.uid ?? '')} /></span>
{:else if node.type === 'ticketRef'}
  {#if refKey && ticketHref}
    <a class="ticket-ref" href={ticketHref(refKey, String(node.attrs?.ticketId ?? ''))}>#{refKey}</a
    >
  {:else}
    <span class="ticket-ref">#{refKey ?? 'ticket'}</span>
  {/if}
{:else}
  {@render children()}
{/if}
