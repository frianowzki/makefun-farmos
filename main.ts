#!/usr/bin/env node
// Hand-in builder for the farmOS make.fun client.
//
// It assembles the submitted package: the static app under app/, the three captures listed by shots.json,
// and dossier.json, which is derived from the two of them by the vendored builder. The work happens in this
// order — arguments, source checks, capture checks, copy, dossier, report — so a bad entry fails before the
// output directory is touched at all.
//
// Node 22, standard library only. Nothing is ever removed: the grader hands in a directory that is a mount
// point (rm of it is EBUSY), so the writer only ever mkdirs and overwrites.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-frontend.ts';

const HOME = dirname(fileURLToPath(import.meta.url));

// The cap numbers go straight into buildDossier. The scorer rebuilds the dossier with exactly these values and
// compares the bytes, so they are contract, not configuration.
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 3, max_bytes: 262144 },
  app_max_files: 993,
  app_max_bytes: 16777216,
} as const;

const CAPTURE_COUNT = 3;
const FALLBACK_OUT = '/output';

const USAGE = [
  'usage: node main.ts [--out <dir>] [--out=<dir>] [-h|--help]',
  '',
  'Builds an entry: app/ and screenshots/ are copied into <dir>, then <dir>/dossier.json is written.',
  `The directory is taken from --out, else $MAKEFUN_OUTPUT_DIR, else ${FALLBACK_OUT}.`,
  'It is created when it is missing, overwritten when it is there, and never deleted.',
  '',
  'example:',
  '  node main.ts --out ./dist',
  '',
].join('\n');

/** A problem the person running this can fix: one line, no stack, exit 2. */
class EntryError extends Error {
  override readonly name = 'EntryError';
}

// ---------------------------------------------------------------------------- command line

interface Settings {
  readonly wantsHelp: boolean;
  readonly outDir: string;
}

/**
 * Reads the command line left to right. `--out` takes the following token, `--out=<dir>` its own tail; a
 * repeated `--out` keeps the last one. Anything unrecognised stops the program with its spelling.
 */
function readArgv(argv: readonly string[]): Settings {
  const rest = argv.slice();
  let wantsHelp = false;
  let chosen: string | undefined;

  while (rest.length > 0) {
    const token = rest.shift() as string;

    if (token === '-h' || token === '--help') {
      wantsHelp = true;
      continue;
    }

    if (token === '--out') {
      const value = rest.shift();
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new EntryError(`--out wants a directory, got ${value === undefined ? 'nothing' : `"${value}"`}`);
      }
      chosen = value;
      continue;
    }

    if (token.startsWith('--out=')) {
      const value = token.slice('--out='.length);
      if (value === '') throw new EntryError('--out= wants a directory after the equals sign');
      chosen = value;
      continue;
    }

    if (token.startsWith('-')) throw new EntryError(`unknown flag "${token}" — node main.ts --help lists the flags`);
    throw new EntryError(`stray argument "${token}" — did you mean: node main.ts --out ${token}?`);
  }

  const fromEnv = process.env.MAKEFUN_OUTPUT_DIR;
  const target = chosen ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : FALLBACK_OUT);
  return { wantsHelp, outDir: resolve(HOME, target) };
}

// ---------------------------------------------------------------------------- shots.json

interface Capture {
  readonly file: string;
  readonly route: string;
  readonly size: string;
}

type Dict = Record<string, unknown>;

function dictOf(value: unknown): Dict | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Dict) : null;
}

/** One capture: the fields the contract needs, and the screenshot on disk it points at. */
function readCapture(raw: unknown, index: number): Capture {
  const slot = `shots.json[${index}]`;

  const entry = dictOf(raw);
  if (entry === null) throw new EntryError(`${slot} is not an object`);

  const file = entry.file;
  if (typeof file !== 'string' || file === '') throw new EntryError(`${slot}.file must be a file name`);
  const at = `${slot} (${file})`;

  if (file.includes('/') || file.includes('\\') || file.startsWith('.')) {
    throw new EntryError(`${at}: file must be a bare name inside screenshots/, not a path`);
  }

  const route = entry.path;
  if (typeof route !== 'string' || route === '') throw new EntryError(`${at}.path must be the route the capture shows`);

  const viewport = dictOf(entry.viewport);
  if (viewport === null) throw new EntryError(`${at}.viewport must be an object with width and height`);

  const { width, height } = viewport;
  if (typeof width !== 'number' || !Number.isFinite(width)) throw new EntryError(`${at}.viewport.width must be a number`);
  if (typeof height !== 'number' || !Number.isFinite(height)) throw new EntryError(`${at}.viewport.height must be a number`);

  const shotPath = join(HOME, 'screenshots', file);
  let bytes: number;
  try {
    const info = statSync(shotPath);
    if (!info.isFile()) throw new EntryError(`${at}: screenshots/${file} is not a file`);
    bytes = info.size;
  } catch (err) {
    if (err instanceof EntryError) throw err;
    throw new EntryError(`${at}: screenshots/${file} is not there (${tellOf(err)})`);
  }

  if (bytes >= CAPS.screenshots.max_bytes) {
    throw new EntryError(`${at}: screenshots/${file} is ${bytes} bytes, which is not under the ${CAPS.screenshots.max_bytes} byte cap`);
  }

  return { file, route, size: `${width}x${height}` };
}

/** The whole capture list, checked end to end before a single byte is copied. */
function readCaptures(): Capture[] {
  const listPath = join(HOME, 'shots.json');
  if (!existsSync(listPath)) throw new EntryError('shots.json is not in the entry directory');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(listPath, 'utf8'));
  } catch (err) {
    throw new EntryError(`shots.json could not be read as JSON: ${tellOf(err)}`);
  }

  if (!Array.isArray(parsed)) throw new EntryError('shots.json must be an array of captures');
  if (parsed.length !== CAPTURE_COUNT) {
    throw new EntryError(`shots.json lists ${parsed.length} capture${parsed.length === 1 ? '' : 's'}; an entry carries exactly ${CAPTURE_COUNT}`);
  }

  const captures = parsed.map(readCapture);
  const names = new Set<string>();
  for (const capture of captures) {
    if (names.has(capture.file)) throw new EntryError(`shots.json uses the file ${capture.file} for more than one capture`);
    names.add(capture.file);
  }
  return captures;
}

// ---------------------------------------------------------------------------- sources

/** app/ must exist with at least one file, and the vendored builder must be present. */
function assertSources(): void {
  const appDir = join(HOME, 'app');
  if (!existsSync(appDir)) throw new EntryError('app/ is not in the entry directory');
  if (!treeHasFile(appDir)) throw new EntryError('app/ holds no files');

  if (!existsSync(join(HOME, 'vendor', 'makefun-frontend.ts'))) {
    throw new EntryError('vendor/makefun-frontend.ts is not in the entry directory');
  }
}

function treeHasFile(dir: string): boolean {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.isFile()) return true;
    if (item.isDirectory() && treeHasFile(join(dir, item.name))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------- writing

/** Copies every file of `source` into `target`, making directories as it goes and replacing files that exist. */
async function copyTree(source: string, target: string): Promise<void> {
  mkdirSync(target, { recursive: true });
  for (const item of await readdir(source, { withFileTypes: true })) {
    const from = join(source, item.name);
    const to = join(target, item.name);
    if (item.isDirectory()) await copyTree(from, to);
    else if (item.isFile()) await copyFile(from, to);
  }
}

async function prepare(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await copyTree(join(HOME, 'app'), join(outDir, 'app'));
  await copyTree(join(HOME, 'screenshots'), join(outDir, 'screenshots'));
}

// ---------------------------------------------------------------------------- report

/** The first `Totals:` line of the dossier's own text. */
function totalsOf(dossier: Uint8Array): string {
  try {
    const doc = dictOf(JSON.parse(Buffer.from(dossier).toString('utf8')));
    const text = doc !== null && typeof doc.text === 'string' ? doc.text : '';
    const line = text.split('\n').find((each) => each.startsWith('Totals:'));
    return line ?? 'Totals: (the dossier has no Totals line)';
  } catch {
    return 'Totals: (the dossier did not parse)';
  }
}

function tellOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printReport(outDir: string, dossier: Uint8Array, captures: readonly Capture[]): void {
  const rows = [
    `built      ${outDir}`,
    `dossier    ${dossier.byteLength} bytes`,
    ...captures.map((c) => `capture    screenshots/${c.file} ${statSync(join(outDir, 'screenshots', c.file)).size} bytes, ${c.size}, ${c.route}`),
    '',
    totalsOf(dossier),
  ];
  process.stdout.write(`${rows.join('\n')}\n`);
}

// ---------------------------------------------------------------------------- run

async function run(argv: readonly string[]): Promise<void> {
  const { wantsHelp, outDir } = readArgv(argv);
  if (wantsHelp) {
    process.stdout.write(USAGE);
    return;
  }

  assertSources();
  const captures = readCaptures();

  await prepare(outDir);

  const dossier = buildDossier(outDir, CAPS);
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  printReport(outDir, dossier, captures);
}

run(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof EntryError) {
    process.stderr.write(`main.ts: ${err.message}\n`);
    process.stderr.write('help: node main.ts --help\n');
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`main.ts: unexpected failure: ${tellOf(err)}\n`);
  process.exitCode = 1;
});
