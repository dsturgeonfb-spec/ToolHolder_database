import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES } from '../helpers.js'
import { describePolicy, isAllowed, parseRobots, policyFor } from '../../src/server/vendors/robots.js'

const haimer = parseRobots(readFileSync(join(FIXTURES, 'vendors', 'haimer', 'robots.txt'), 'utf8'))

test('HAIMER robots.txt: our agent gets the * group — Crawl-delay 10, /search /printpage/ /downloadfile/ disallowed', () => {
  const p = policyFor(haimer, 'HolderCatalogue')
  assert.equal(p.matched, '*')
  assert.equal(p.crawlDelay, 10)
  assert.deepEqual(p.sitemaps, ['https://shop.haimer.com/sitemap.xml'])
  assert.equal(isAllowed(p, '/en/Power-Mini-Shrink-Chuck-DIN-69893-1-HSK-A63/A63.182.03.8'), true)
  assert.equal(isAllowed(p, '/sitemap.xml'), true)
  assert.equal(isAllowed(p, '/search?search=A63.182'), false)
  assert.equal(isAllowed(p, '/en/search?search=A63.182'), false, 'language variant /*/search')
  assert.equal(isAllowed(p, '/printpage/f1afe088f28947f6993eedbe4c23fff7'), false)
  assert.equal(isAllowed(p, '/us/printpage/f1afe088f28947f6993eedbe4c23fff7'), false)
  assert.equal(isAllowed(p, '/downloadfile/A63.182.03.8.stp'), false)
  assert.equal(isAllowed(p, '/robots.txt'), true)
  assert.match(describePolicy(p), /Crawl-delay 10 s; disallows .*\/search/)
})

test('user-agent groups: a named group replaces * for that agent; agent match is case-insensitive', () => {
  const meta = policyFor(haimer, 'meta-externalagent/1.1')
  assert.equal(meta.matched, 'meta-externalagent')
  assert.equal(isAllowed(meta, '/en/anything'), false)
  assert.match(describePolicy(meta), /everything disallowed/)

  const f = parseRobots(`User-agent: *\nDisallow: /\n\nUser-agent: HolderCatalogue\nUser-agent: OtherBot\nAllow: /en/\nDisallow: /en/private\nCrawl-delay: 4\n`)
  const ours = policyFor(f, 'HolderCatalogue/0.1.0 (+eng@example.com)'.split('/')[0]!)
  assert.equal(ours.matched, 'holdercatalogue')
  assert.equal(ours.crawlDelay, 4)
  assert.equal(isAllowed(ours, '/en/products/1'), true)
  assert.equal(isAllowed(ours, '/en/private/x'), false)
  assert.equal(isAllowed(ours, '/de/x'), true, 'no rule matches → allowed')
  const other = policyFor(f, 'SomethingElse')
  assert.equal(other.matched, '*')
  assert.equal(isAllowed(other, '/en/products/1'), false)
})

test('rule precedence: longest match wins, Allow wins a tie; * wildcards and $ anchors; empty Disallow allows all', () => {
  const p = policyFor(
    parseRobots(`# comment\nUser-agent: *\nDisallow: /shop/\nAllow: /shop/p/\nDisallow: /*.pdf$\nDisallow: /a\nAllow: /a\nDisallow:\n`),
    'HolderCatalogue',
  )
  assert.equal(isAllowed(p, '/shop/cart'), false)
  assert.equal(isAllowed(p, '/shop/p/30524702'), true)
  assert.equal(isAllowed(p, '/media/drawing.pdf'), false)
  assert.equal(isAllowed(p, '/media/drawing.pdf?x=1'), true, '$ anchors the end')
  assert.equal(isAllowed(p, '/abc'), true, 'Allow wins a tie of equal length')
  const open = policyFor(parseRobots('User-agent: *\nDisallow:\n'), 'HolderCatalogue')
  assert.equal(isAllowed(open, '/anything'), true)
  assert.equal(open.crawlDelay, null)
})

test('robots.txt with no group for us and no * group allows everything; Crawl-delay with a decimal comma is read', () => {
  const p = policyFor(parseRobots('User-agent: BadBot\nDisallow: /\n'), 'HolderCatalogue')
  assert.equal(p.matched, null)
  assert.equal(isAllowed(p, '/x'), true)
  assert.equal(policyFor(parseRobots('User-agent: *\nCrawl-delay: 2,5\n'), 'HolderCatalogue').crawlDelay, 2.5)
  assert.match(describePolicy(null), /No robots.txt/)
})
