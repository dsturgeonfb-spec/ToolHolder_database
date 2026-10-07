/**
 * Printable HTML documents (count sheets, RFQ sheets, the hyperMILL write-back list).
 * Self-contained: inline CSS, no scripts, A4-friendly. Opened inline in a new window and printed.
 */
export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function printPage(title: string, bodyHtml: string, opts: { subtitle?: string; landscape?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @page { size: A4 ${opts.landscape ? 'landscape' : 'portrait'}; margin: 12mm; }
  body { font-family: "Segoe UI", system-ui, sans-serif; font-size: 11pt; color: #15202A; margin: 0; padding: 16px; background: #fff; }
  h1 { font-size: 18pt; margin: 0 0 2px; } h2 { font-size: 13pt; margin: 18px 0 6px; page-break-after: avoid; }
  .sub { color: #4B5966; margin: 0 0 12px; font-size: 10pt; }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th, td { border: 1px solid #C9D2DA; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #EEF2F5; font-weight: 600; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.box { width: 18mm; }
  .mono { font-family: Consolas, "JetBrains Mono", monospace; }
  .muted { color: #4B5966; }
  .sign { margin-top: 18px; display: flex; gap: 40px; font-size: 10pt; }
  .sign span { border-top: 1px solid #15202A; padding-top: 2px; min-width: 60mm; display: inline-block; }
  .noprint { margin: 0 0 12px; }
  @media print { .noprint { display: none; } body { padding: 0; } }
</style></head><body>
<div class="noprint"><button onclick="window.print()">Print</button></div>
<h1>${esc(title)}</h1>${opts.subtitle ? `<p class="sub">${esc(opts.subtitle)}</p>` : ''}
${bodyHtml}
</body></html>`
}
