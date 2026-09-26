/**
 * Files on tickets, opened natively (agents.html §I).
 *
 *   <FileGrid files={…} onopen={(f) => fileViewer.open(f, files)} hrefFor={…} />
 *   <FileViewer files={…} bind:current layout="overlay" onclose={…} />
 *   kindOf(file) / infoOf(file) — from @tm/shared fileInfo()
 */
export { default as FileCard } from './FileCard.svelte';
export { default as FileGrid } from './FileGrid.svelte';
export { default as FileViewer } from './FileViewer.svelte';
export { default as FileContent } from './FileContent.svelte';
export { default as HtmlFrame } from './HtmlFrame.svelte';
export { default as CodeView } from './CodeView.svelte';
export { default as CsvTable } from './CsvTable.svelte';
export { default as MarkdownDoc } from './MarkdownDoc.svelte';
export { default as ImageZoom } from './ImageZoom.svelte';
export * from './kinds';
export * from './csv';
export * from './source';
export * from './viewer.svelte';
export type { ViewerFile } from './types';
