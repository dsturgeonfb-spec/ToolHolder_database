/**
 * Shapes shared by the vendor adapters, the diff/approve step and the routes (docs/API.md "Vendors").
 *
 * An adapter turns a maker's web page (or a row of a maker's data file) into a HolderRecord that uses
 * our own holders column names. Nothing an adapter returns is written anywhere: it becomes a Proposal
 * that a person approves field by field (BUILD_SPEC §3 — the user approves first).
 */
import type { DataStatus } from '../domain.js'
import type { Db } from '../db.js'
import type { PoliteFetcher } from './fetcher.js'

/** One maker data record, in our column names. Absent/null means "the source did not say". */
export interface HolderRecord {
  manufacturer: string
  order_no: string
  /** The interface the source states, as written there (checked against the scan's interface). */
  interface_seen?: string | null
  /** Explicit interface column from a data file (must equal the chosen interface). */
  interface_code?: string | null
  spec_code?: string | null
  product_name?: string | null
  series?: string | null
  type_code?: string | null
  clamp_dia_mm?: number | null
  clamp_min_mm?: number | null
  clamp_max_mm?: number | null
  clamp_spec?: string | null
  gauge_length_mm?: number | null
  gauge_length_ref?: string | null
  nose_dia_mm?: number | null
  dims?: Record<string, string | number>
  coolant?: string | null
  balance?: string | null
  max_rpm?: number | null
  mass_kg?: number | null
  product_url?: string | null
  image_url?: string | null
  drawing_url?: string | null
  notes?: string | null
  data_status: DataStatus
  data_source: string
  /**
   * Fields whose values are the reason data_status is 'partial' (e.g. Kemmler's LPR → gauge length mapping
   * still to be confirmed). Approving a change that leaves these untouched does not downgrade a verified row.
   */
  partial_fields?: string[]
  /** Things the person should look at before approving (shown on the proposal). */
  warnings?: string[]
  /**
   * Notes about the holder type ("will be added as Other"). They only matter when the record becomes a new
   * holder — an existing holder's type is never changed by a scan or import — so only insert proposals show them.
   */
  type_warnings?: string[]
  /**
   * Values (by ISO 13399 code, e.g. DLN) that went into holder columns. They are not maker dimensions of their
   * own; they only update a dimension the holder already carries under the same code ("DLN (diameter lock
   * nut)"), so the holder page never shows a stale copy next to the column value. Never added as new labels.
   */
  dims_refresh?: Record<string, string | number>
}

/** A product to read: an order no. and, when known, the page that describes it. */
export interface ProductRef {
  order_no: string
  url?: string | null
  holder_id?: string
  /** catalogue = already in our DB, entered = typed by the user, discovered = found in the maker's sitemap. */
  origin: 'catalogue' | 'entered' | 'discovered'
  /** Set when discovery already knows this ref cannot be read (e.g. not in the maker's sitemap). */
  error?: string
}

export interface ScanContext {
  db: Db
  fetcher: PoliteFetcher
  log: (message: string) => void
  signal?: AbortSignal
}

export interface DiscoverOptions {
  /** Holders of this maker and interface already in the catalogue. */
  known: ProductRef[]
  /** Order nos the person typed in. */
  entered: string[]
  /** "Discover the full range" (only HAIMER has a sitemap to discover from). */
  full: boolean
}

export interface VendorAdapter {
  /** manufacturers.name */
  maker: string
  /** How data is obtained, in a few words (shown on the maker card). */
  method: string
  /** false = manual route (file import / rep data); the app never scrapes these sites. */
  automated: boolean
  /** Why this method, in plain English. */
  notes: string
  /** What the maker's robots.txt says / how politely we fetch. */
  robots: string
  /** Best entry point on the maker's site (opened in the browser), or null. */
  source_url: string | null
  /**
   * The only origins (https://host) a scan of this maker may contact — enforced by the fetcher for every
   * request and redirect hop. Also used for the live robots.txt summary on the maker card.
   */
  origins?: string[]
  /** Where the maker's product photos live, when not on `origins` (the photo cache only downloads from these). */
  imageOrigins?: string[]
  /** Seconds between page requests expected before robots.txt has been read (for time estimates). */
  delay_hint_s?: number
  discover?(sc: ScanContext, iface: string, opts: DiscoverOptions): Promise<ProductRef[]>
  fetch?(sc: ScanContext, ref: ProductRef, iface: string): Promise<HolderRecord>
}

export type ProposalAction = 'insert' | 'update' | 'same' | 'error'

export interface FieldChange {
  old: unknown
  new: unknown
  /** dims only: the labels that are new or changed. */
  keys?: string[]
}

export interface Proposal {
  order_no: string
  manufacturer: string
  action: ProposalAction
  holder_id?: string
  /** Changed fields (update), all fields (insert), none (same/error). `dims` holds whole objects. */
  fields: Record<string, FieldChange>
  record: HolderRecord | null
  source_url: string | null
  warnings: string[]
  error?: string
}
