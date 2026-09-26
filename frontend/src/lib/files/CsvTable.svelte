<!-- CSV / TSV as a table (first row = header), capped at 5 000 rows. -->
<script lang="ts">
  import { parseCsv } from './csv';

  let {
    text,
    name = '',
    truncatedFile = false,
  }: { text: string; name?: string; truncatedFile?: boolean } = $props();
  const table = $derived(parseCsv(text, { name, maxRows: 5000 }));
  const head = $derived(table.rows[0] ?? []);
  const body = $derived(table.rows.slice(1));
  const width = $derived(Math.max(0, ...table.rows.slice(0, 200).map((r) => r.length)));
</script>

<div class="overflow-auto">
  <table class="min-w-full border-collapse text-sm">
    <thead class="sticky top-0 z-[1] bg-surface-2">
      <tr>
        <th class="border border-line px-2 py-1 text-right text-xs font-normal text-subtle">#</th>
        {#each Array.from({ length: width }, (_, i) => head[i] ?? '') as h, i (i)}
          <th class="border border-line px-2 py-1 text-left font-semibold whitespace-nowrap">{h}</th
          >
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each body as row, r (r)}
        <tr class="even:bg-surface-2/40">
          <td class="border border-line px-2 py-1 text-right text-xs text-subtle">{r + 1}</td>
          {#each Array.from({ length: width }, (_, i) => row[i] ?? '') as cell, i (i)}
            <td class="max-w-md border border-line px-2 py-1 align-top whitespace-pre-wrap"
              >{cell}</td
            >
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
  {#if table.truncated || truncatedFile}
    <p class="px-2 py-2 text-xs text-muted">
      Showing the first {body.length.toLocaleString()} rows — download the file for the rest.
    </p>
  {/if}
</div>
