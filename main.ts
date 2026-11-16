// Driver: render every case in cases.json alone with parse() and write the
// HTML strings, in order, to html.json. The input/output directories come
// from the environment (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR), defaulting
// to the harness mounts /input and /output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = new Array(cases.length);
for (let k = 0; k < cases.length; k++) html[k] = parse(cases[k].markdown);
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
