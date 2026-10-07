/**
 * Catalogue module: holder list/detail, manual entry and edits from maker catalogues, the tally,
 * and catalogue/tally exports. Routes and shapes: docs/API.md "Catalogue".
 * The work lives in ../catalogue/*; this file only maps routes to it.
 */
import type { Router } from '../http.js'
import type { AppContext } from '../context.js'
import { countAllHolders, holderDetail, listHolders, parseFilters } from '../catalogue/holders.js'
import { createHolder, updateHolder } from '../catalogue/write.js'
import { buildTally } from '../catalogue/tally.js'
import { catalogueCsv, catalogueXlsx, tallyCsv, tallyXlsx } from '../catalogue/exports.js'
import { getSummary } from '../domain.js'

export function register(r: Router, ctx: AppContext): void {
  r.get('/api/holders', (req) => {
    const f = parseFilters(req.query)
    return { holders: listHolders(ctx, f), total: countAllHolders(ctx) }
  })
  r.get('/api/holders/:id', (req) => holderDetail(ctx, req.params.id!))
  r.post('/api/holders', (req) => createHolder(ctx, req))
  r.patch('/api/holders/:id', (req) => updateHolder(ctx, req))

  // The tally's summary is exactly the header strip's numbers (one query, in domain.ts).
  r.get('/api/tally', () => buildTally(ctx, getSummary(ctx.db)))

  r.get('/api/export/catalogue.csv', (req) => catalogueCsv(ctx, req.query))
  r.get('/api/export/catalogue.xlsx', (req) => catalogueXlsx(ctx, req.query))
  r.get('/api/export/tally.csv', () => tallyCsv(ctx))
  r.get('/api/export/tally.xlsx', () => tallyXlsx(ctx))
}
