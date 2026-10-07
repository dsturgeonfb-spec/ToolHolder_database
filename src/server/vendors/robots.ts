/**
 * robots.txt (RFC 9309 plus the common Crawl-delay extension).
 *
 * The app reads a maker's robots.txt before any other request to that site and obeys it: paths that
 * are disallowed for our user agent are never requested, and Crawl-delay sets the gap between requests
 * (never less than our own 2 s minimum). HAIMER, for example, asks for 10 s and disallows /search,
 * /printpage/ and /downloadfile/.
 */

export interface RobotsRule {
  allow: boolean
  pattern: string
}

export interface RobotsGroup {
  agents: string[]
  rules: RobotsRule[]
  crawlDelay: number | null
}

export interface RobotsFile {
  groups: RobotsGroup[]
  sitemaps: string[]
}

/** The rules that apply to one user agent. */
export interface RobotsPolicy {
  /** The group's user-agent line that matched ('*' when only the default group applies, null when none). */
  matched: string | null
  rules: RobotsRule[]
  /** Seconds, or null when the site does not say. */
  crawlDelay: number | null
  sitemaps: string[]
}

export function parseRobots(text: string): RobotsFile {
  const groups: RobotsGroup[] = []
  const sitemaps: string[] = []
  let current: RobotsGroup | null = null
  // A run of user-agent lines starts a group; the first rule line closes the run.
  let collectingAgents = false
  for (const rawLine of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    if (key === 'user-agent') {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [], crawlDelay: null }
        groups.push(current)
        collectingAgents = true
      }
      current.agents.push(value.toLowerCase())
      continue
    }
    if (key === 'sitemap') {
      if (value) sitemaps.push(value)
      continue
    }
    if (!current) continue
    collectingAgents = false
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow means "allow everything"; it adds no rule.
      if (value) current.rules.push({ allow: key === 'allow', pattern: value })
    } else if (key === 'crawl-delay') {
      const n = Number(value.replace(',', '.'))
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n
    }
  }
  return { groups, sitemaps }
}

/**
 * Picks the group for our product token (e.g. "HolderCatalogue"): the most specific user-agent line
 * that is contained in the token wins; otherwise the '*' group. Several groups naming the same agent
 * are merged, as RFC 9309 asks.
 */
export function policyFor(file: RobotsFile, productToken: string): RobotsPolicy {
  const token = productToken.toLowerCase()
  let best = ''
  for (const g of file.groups) for (const a of g.agents) if (a !== '*' && a && token.includes(a) && a.length > best.length) best = a
  const pick = best || (file.groups.some((g) => g.agents.includes('*')) ? '*' : '')
  if (!pick) return { matched: null, rules: [], crawlDelay: null, sitemaps: file.sitemaps }
  const chosen = file.groups.filter((g) => g.agents.includes(pick))
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d != null)
  return {
    matched: pick,
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: delays.length ? Math.max(...delays) : null,
    sitemaps: file.sitemaps,
  }
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$')
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp('^' + body + (anchored ? '$' : ''))
}

/** Percent-encoding differences must not decide a match: compare decoded forms. */
function normPath(p: string): string {
  try {
    return decodeURI(p)
  } catch {
    return p
  }
}

/**
 * Is `pathAndQuery` (e.g. "/en/Foo/A63.182.03.8") allowed? Longest matching rule wins; on a tie Allow
 * wins (RFC 9309 §2.2.2). /robots.txt itself is always allowed.
 */
export function isAllowed(policy: RobotsPolicy, pathAndQuery: string): boolean {
  const path = normPath(pathAndQuery || '/')
  if (path === '/robots.txt') return true
  let best: RobotsRule | null = null
  let bestLen = -1
  for (const r of policy.rules) {
    if (!patternToRegex(normPath(r.pattern)).test(path)) continue
    const len = r.pattern.length
    if (len > bestLen || (len === bestLen && r.allow && best && !best.allow)) {
      best = r
      bestLen = len
    }
  }
  return best ? best.allow : true
}

/** Plain-English summary for the maker card: delay and the disallowed paths. */
export function describePolicy(policy: RobotsPolicy | null): string {
  if (!policy) return 'No robots.txt — the app keeps its own 2 s minimum between requests.'
  const dis = policy.rules.filter((r) => !r.allow).map((r) => r.pattern)
  const parts: string[] = []
  parts.push(policy.crawlDelay != null ? `Crawl-delay ${policy.crawlDelay} s` : 'No crawl-delay (2 s minimum used)')
  if (dis.includes('/')) parts.push('everything disallowed for this app')
  else if (dis.length) parts.push(`disallows ${dis.slice(0, 8).join(', ')}${dis.length > 8 ? ` and ${dis.length - 8} more` : ''}`)
  return parts.join('; ')
}
