/**
 * Every feature module registers its routes here. One file per module; a module owns its
 * routes, its SQL and its rules (built on ../domain.ts for the shared data rules).
 */
import type { Router } from '../http.js'
import type { AppContext } from '../context.js'
import * as catalogue from './catalogue.js'
import * as stock from './stock.js'
import * as flags from './flags.js'
import * as hypermill from './hypermill.js'
import * as vendors from './vendors.js'
import * as purchasing from './purchasing.js'
import * as units from './units.js'
import * as system from './system.js'

export function registerModules(router: Router, ctx: AppContext): void {
  for (const m of [catalogue, stock, flags, hypermill, vendors, purchasing, units, system]) m.register(router, ctx)
}
