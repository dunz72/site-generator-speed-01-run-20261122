[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/dunz72/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/dunz72/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122

A faster drop-in for makefun-site 1.0.0 — [make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122) "Build a static site faster, 22 November 2026" ($100, top 10 × $10).

`run(input)` in `solve.js` returns, for every case's input, exactly the answer
makefun-site 1.0.0's `build` returns: the output tree of the generated site, byte
for byte. `main.ts` is the kit's driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## How it is faster

An independent, from-scratch reimplementation of makefun-site's documented
behaviour (its README: front matter, template dialect, Markdown subset, slug
rule, report), written for speed:

- **Templates compiled to JavaScript** — each parsed template is compiled once
  per case with `new Function` into straight-line code: direct scope-chain
  reads, guarded own-property steps, a single fused escape+text helper, and
  loop scopes reused across iterations (with the tree-walking interpreter kept
  as a fallback if compilation is unavailable).
- **Single-pass Markdown** — blocks render directly with no token objects;
  inline rendering fuses HTML escaping into the same scan that finds code
  spans, emphasis, strong and links; closer searches take a fast path when no
  backslash can hide them.
- **Cheap primitives** — regex-based HTML escaping, cached slugs and long
  dates, memoised link resolution, allocation-free word counting, manual line
  trimming, and first-character block dispatch.

On the kit's practice set it answers all 3 cases byte-identically to the
reference and runs ~2.8× faster than the house baseline in warm runs
(~170 ms vs ~460 ms for the three cases' `run()` calls), verified further on
15 extra cases drawn from fresh seeds with the kit's own generator.

## Layout

- `solve.js` — the entry: `export function run(input)`.
- `main.ts` — the kit's driver (unchanged).
- `package.json` — `{"type": "module"}`.

## make.fun

Built for [make.fun](https://make.fun) — referral code `rwrq8ddk`.
