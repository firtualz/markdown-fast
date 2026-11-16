[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/firtualz/markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/firtualz/markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-fast

A fast Markdown renderer that produces byte-identical output to
[marked](https://github.com/markedjs/marked) 18.1.3 (default options, GFM
enabled) — written from scratch, dependency-free, as a single ES module.

Built for the make.fun bounty **markdown-render-speed-02**.

## Usage

```js
import { parse } from './parse.js';

parse('# Hello\n\nThis is *emphasized*.');
// '<h1>Hello</h1>\n<p>This is <em>emphasized</em>.</p>\n'
```

`parse(markdown)` takes a Markdown string and returns the HTML string
marked 18.1.3 would produce for it, code-unit for code-unit. It handles the
full CommonMark 0.31.2 spec plus GFM (tables, strikethrough, autolinks, task
lists), including the edge cases where marked's behavior is subtle: entity
handling, backslash escapes, link reference definitions, emphasis delimiter
rules, tab expansion, and HTML blocks.

## How it works

Single-pass index/stride scanner that emits HTML directly while scanning —
no token tree (marked builds one, which is a large part of why it is
slower). Character-code dispatch, run-based copying instead of
character-by-character loops, and minimal allocation in the hot path.

## Files

- `parse.js` — the renderer (dependency-free ES module, `parse` / default export).
- `main.ts` — harness driver: reads `cases.json` from
  `MAKEFUN_INPUT_DIR` (default `/input`), renders each case alone with
  `parse`, writes the HTML strings to `html.json` in `MAKEFUN_OUTPUT_DIR`
  (default `/output`).
- `LICENSE` — MIT.

## Performance

On the 720-case practice set (652 CommonMark + 28 GFM + 40 generated
documents, ~2.9M chars of Markdown), median of 30 runs on the author's
machine: ~387,000 µs total vs ~691,000 µs for marked itself — about 1.8x
faster than marked while matching its output exactly on all 720 cases.

## License

MIT. See `LICENSE`.
