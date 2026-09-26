<!--
  The QUESTION CARD (agents.html §L1) — an agent's question, in the thread,
  as a form:
    radio buttons for single choice, checkboxes for multiple, inputs for the
    rest, an optional 'Anything else?' box and Submit.
  Once answered the card LOCKS where it sits and prints the chosen values with
  'Answered by Panth · 10:42'; the answer also arrives as the person's own
  reply bubble (the command posts it). Cancelled and expired lock the same
  way. When `to` is set, only those people can answer and the card says whom
  it is waiting for.

  Submit goes through the outbox like every other write: the card locks at
  once (an optimistic patch on the message) and nothing waits for the server.
-->
<script lang="ts">
  import { Ban, CircleCheckBig, CircleHelp, Clock, Loader2 } from 'lucide-svelte';
  import {
    isAgentId,
    paths,
    questionStatus,
    type Question,
    type QuestionField,
    type QuestionValue,
  } from '@tm/shared';
  import { outbox } from '$lib/api';
  import { RichView } from '$lib/editor';
  import { routes } from '$lib/layout/routes';
  import { Badge, Button, DatePicker, Input, Textarea } from '$lib/ui';
  import { getTicketCtx } from './context';
  import {
    answerAbility,
    answeredLines,
    blankForm,
    checkForm,
    fieldError,
    formErrors,
    isBlankForm,
    statusLabel,
    waitingFor,
    type FormValues,
  } from './question';
  import { formatFull } from './time';

  interface Props {
    /** The message the question lives on (§L1: one document, one thread position). */
    messageId: string;
    question: Question;
    /** Who asked — the message author. A person or an agent (§N: both ask). */
    askedBy?: string | null;
    /** Still on its way out (an outbox stand-in): the form is not live yet. */
    pending?: boolean;
    /**
     * The builder's live preview (§N1): the card is drawn exactly as the
     * thread will render it, but nothing it contains does anything.
     */
    preview?: boolean;
  }
  let { messageId, question, askedBy = null, pending = false, preview = false }: Props = $props();

  const t = getTicketCtx();

  /** Re-read each minute so an expiry locks the card while it is on screen. */
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(id);
  });

  const status = $derived(questionStatus(question, now));
  const nameOf = (id: string) => t.members.find((m) => m.uid === id)?.name || 'someone';
  const ability = $derived(
    t.board && !pending && !preview
      ? answerAbility({ actor: t.me }, t.board, question, now, nameOf)
      : { can: false, reason: null },
  );
  /** Open + I may answer + the ticket's thread is not closed. */
  const editable = $derived(
    preview ? status === 'open' : status === 'open' && ability.can && !t.perms.closed,
  );

  // ——— the form
  // The question a card is built for never changes identity mid-life; a new
  // one arrives as a new messageId, which the effect below rebuilds for.
  // svelte-ignore state_referenced_locally
  let values = $state<FormValues>(blankForm(question));
  let comment = $state('');
  let touched = $state(false);
  // A question is replaced in place (answer / cancel), so rebuild when the id changes.
  // svelte-ignore state_referenced_locally
  let builtFor = $state(messageId);
  $effect(() => {
    if (builtFor !== messageId) {
      builtFor = messageId;
      values = blankForm(question);
      comment = '';
      touched = false;
    }
  });

  const check = $derived(checkForm(question, values, comment));
  const blank = $derived(isBlankForm(values, comment));
  const errs = $derived(touched ? formErrors(check) : []);
  const err = (id: string) => (touched ? fieldError(check, id) : null);

  const answer = $derived(question.answer);
  const lines = $derived(answeredLines(question, t.tz));
  const answeredBy = $derived(answer ? nameOf(answer.by) : null);

  function toggleMulti(f: QuestionField, optionId: string, on: boolean) {
    const cur = Array.isArray(values[f.id]) ? (values[f.id] as string[]) : [];
    values[f.id] = on ? [...cur, optionId] : cur.filter((x) => x !== optionId);
  }

  function submit() {
    if (preview) return; // the preview card is scenery, not a form
    touched = true;
    if (!check.ok || blank || !editable) return;
    const at = Date.now();
    const text = comment.trim();
    const values_ = check.values as Record<string, QuestionValue>;
    outbox.queue(
      'questionAnswer',
      {
        boardId: t.boardId,
        ticketId: t.ticketId,
        messageId,
        values: values_,
        ...(text ? { comment: text } : {}),
      },
      {
        kind: 'ticket',
        label: `answer “${question.title}”`,
        openTo: `${routes.ticket(t.ticket.key)}?m=${messageId}`,
        // The card locks straight away, where it already sits in the thread.
        optimistic: {
          path: paths.message(t.boardId, t.ticketId, messageId),
          patch: {
            'question.status': 'answered',
            'question.answer': {
              values: values_,
              ...(text ? { comment: text } : {}),
              by: t.me,
              at,
            },
          },
        },
      },
    );
  }

  /**
   * §N1: 'The asker (and board admins) can cancel an open question.' The asker
   * is the message author — an agent through its token, or the person who
   * built it in the composer.
   */
  const canCancel = $derived(
    status === 'open' &&
      !pending &&
      !preview &&
      !t.perms.closed &&
      ((askedBy !== null && askedBy === t.me && t.perms.comment) || t.perms.role === 'admin'),
  );
  function cancel() {
    outbox.queue(
      'questionCancel',
      { boardId: t.boardId, ticketId: t.ticketId, messageId },
      {
        kind: 'ticket',
        label: `cancel “${question.title}”`,
        openTo: `${routes.ticket(t.ticket.key)}?m=${messageId}`,
        optimistic: {
          path: paths.message(t.boardId, t.ticketId, messageId),
          patch: { 'question.status': 'cancelled', 'question.cancelledAt': Date.now() },
        },
      },
    );
  }

  const TONE = {
    open: 'accent',
    answered: 'success',
    cancelled: 'neutral',
    expired: 'warning',
  } as const;
</script>

<section
  class="my-1 flex w-full flex-col gap-2.5 rounded-xl border bg-surface p-3
    {status === 'open' ? 'border-accent/60' : 'border-line'}"
  aria-label="Question: {question.title}"
  data-question={messageId}
  data-question-status={status}
>
  <header class="flex flex-wrap items-start gap-2">
    <span class="mt-0.5 shrink-0 text-accent" aria-hidden="true">
      {#if status === 'answered'}<CircleCheckBig size={16} class="text-success" />
      {:else if status === 'cancelled'}<Ban size={16} class="text-muted" />
      {:else if status === 'expired'}<Clock size={16} class="text-warning" />
      {:else}<CircleHelp size={16} />{/if}
    </span>
    <h3 class="min-w-0 flex-1 text-sm font-semibold break-words">{question.title}</h3>
    <Badge tone={TONE[status]}>{statusLabel(status)}</Badge>
  </header>

  {#if question.body}
    <RichView doc={question.body.doc} ticketHref={t.ticketHref} class="text-sm text-muted" />
  {/if}

  {#if status === 'open' && question.to?.length}
    <p class="text-xs text-subtle">Waiting for {waitingFor(question.to, nameOf)}.</p>
  {/if}
  {#if status === 'open' && question.expiresAt != null}
    <p class="text-xs text-subtle">Expires {formatFull(question.expiresAt, t.tz)}.</p>
  {/if}

  {#if status === 'answered' && answer}
    <!-- Locked: the chosen values, in the question's own order. -->
    <dl class="flex flex-col gap-1.5">
      {#each lines as l (l.fieldId)}
        <div class="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
          <dt class="shrink-0 text-xs font-medium text-muted sm:w-36">{l.label}</dt>
          <dd class="min-w-0 text-sm break-words">{l.text}</dd>
        </div>
      {/each}
      {#if !lines.length}<p class="text-sm text-muted italic">Left blank.</p>{/if}
    </dl>
    {#if answer.comment}
      <p class="rounded-md bg-surface-2 px-2.5 py-1.5 text-sm break-words">{answer.comment}</p>
    {/if}
    <p class="text-xs text-subtle">
      Answered by {answeredBy} ·
      <time title={formatFull(answer.at, t.tz)}>
        {new Date(answer.at).toLocaleTimeString(undefined, {
          timeZone: t.tz,
          hour: 'numeric',
          minute: '2-digit',
        })}
      </time>
    </p>
  {:else if status === 'cancelled'}
    <p class="text-sm text-muted">
      {isAgentId(askedBy) ? 'The agent took this question back.' : 'This question was taken back.'}
    </p>
  {:else if status === 'expired'}
    <p class="text-sm text-muted">Nobody answered in time.</p>
  {:else if editable}
    <!-- Open, and mine to answer: the form. -->
    <form
      class="flex flex-col gap-3"
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {#each question.fields as f (f.id)}
        {@const fe = err(f.id)}
        <fieldset class="flex min-w-0 flex-col gap-1.5">
          {#if f.type === 'single' || f.type === 'multi'}
            <legend class="text-xs font-medium text-muted">
              {f.label}{#if f.required}<span class="text-danger" aria-hidden="true"> *</span>{/if}
            </legend>
            <div class="flex flex-col gap-1">
              {#each f.options ?? [] as o (o.id)}
                <label
                  class="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-surface-2"
                >
                  {#if f.type === 'single'}
                    <input
                      type="radio"
                      name="{messageId}-{f.id}"
                      value={o.id}
                      checked={values[f.id] === o.id}
                      onchange={() => (values[f.id] = o.id)}
                      class="mt-0.5 size-4 shrink-0 accent-[var(--tm-accent)]"
                    />
                  {:else}
                    <input
                      type="checkbox"
                      value={o.id}
                      checked={Array.isArray(values[f.id]) &&
                        (values[f.id] as string[]).includes(o.id)}
                      onchange={(e) => toggleMulti(f, o.id, e.currentTarget.checked)}
                      class="mt-0.5 size-4 shrink-0 rounded accent-[var(--tm-accent)]"
                    />
                  {/if}
                  <span class="min-w-0">
                    {o.label}
                    {#if o.description}<span class="block text-xs text-muted">{o.description}</span
                      >{/if}
                  </span>
                </label>
              {/each}
            </div>
          {:else if f.type === 'longText'}
            <Textarea
              label={f.label}
              required={f.required}
              rows={3}
              placeholder={f.placeholder}
              error={fe}
              value={(values[f.id] as string) ?? ''}
              oninput={(e) => (values[f.id] = e.currentTarget.value)}
            />
          {:else if f.type === 'boolean'}
            <span class="text-xs font-medium text-muted">
              {f.label}{#if f.required}<span class="text-danger" aria-hidden="true"> *</span>{/if}
            </span>
            <div class="flex gap-1.5">
              {#each [true, false] as v (v)}
                <button
                  type="button"
                  aria-pressed={values[f.id] === v}
                  onclick={() => (values[f.id] = values[f.id] === v ? null : v)}
                  class="tm-press h-8 rounded-md border px-3 text-sm
                    {values[f.id] === v
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line hover:bg-surface-2'}"
                >
                  {v ? 'Yes' : 'No'}
                </button>
              {/each}
            </div>
          {:else if f.type === 'date'}
            <span class="text-xs font-medium text-muted">
              {f.label}{#if f.required}<span class="text-danger" aria-hidden="true"> *</span>{/if}
            </span>
            <DatePicker
              value={(values[f.id] as number | null) ?? null}
              tz={t.tz}
              withTime={false}
              onchange={(v) => (values[f.id] = v)}
            />
          {:else}
            <Input
              label={f.label}
              required={f.required}
              type={f.type === 'number' ? 'number' : 'text'}
              placeholder={f.placeholder}
              error={fe}
              value={(values[f.id] as string | number | null) ?? ''}
              oninput={(e) =>
                (values[f.id] =
                  f.type === 'number'
                    ? e.currentTarget.value === ''
                      ? null
                      : Number(e.currentTarget.value)
                    : e.currentTarget.value)}
            />
          {/if}
          {#if fe && (f.type === 'single' || f.type === 'multi' || f.type === 'boolean' || f.type === 'date')}
            <p class="text-xs text-danger" role="alert">{fe}</p>
          {/if}
        </fieldset>
      {/each}

      {#if question.allowComment}
        <Textarea label="Anything else?" rows={2} bind:value={comment} maxlength={2000} />
      {/if}

      {#each errs as e (e)}<p class="text-xs text-danger" role="alert">{e}</p>{/each}

      <div class="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={blank || (touched && !check.ok)}
          >Submit</Button
        >
        {#if canCancel}<Button variant="ghost" size="sm" onclick={cancel}>Cancel question</Button
          >{/if}
      </div>
    </form>
  {:else}
    <!-- Open, but not mine to answer (or the thread is closed). -->
    <ul class="flex flex-col gap-1">
      {#each question.fields as f (f.id)}
        <li class="text-sm text-muted">
          {f.label}{#if f.options?.length}<span class="text-subtle">
              · {f.options.map((o) => o.label).join(' / ')}</span
            >{/if}
        </li>
      {/each}
    </ul>
    {#if pending}
      <p class="flex items-center gap-1.5 text-xs text-subtle">
        <Loader2 size={12} class="animate-spin" /> Sending…
      </p>
    {:else if ability.reason}
      <p class="text-xs text-subtle">{ability.reason}</p>
    {:else if t.perms.closed}
      <p class="text-xs text-subtle">
        This ticket is closed, so the question can no longer be answered.
      </p>
    {/if}
  {/if}

  <!-- The asker (or an admin) can take an open question back, whether or not
       the form is theirs to fill in. -->
  {#if canCancel && !editable}
    <div><Button variant="ghost" size="sm" onclick={cancel}>Cancel question</Button></div>
  {/if}
</section>
