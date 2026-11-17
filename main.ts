#!/usr/bin/env node
// Entry point for the farmOS make.fun client.
// What it does, in order:
//   1. read the command line (--out <dir>, -h/--help),
//   2. check the hand-in material (shots.json, screenshots/, app/, the vendored library),
//   3. stage app/ and screenshots/ into the output directory,
//   4. write dossier.json with the vendored builder,
//   5. print a short report.
// Node 22 standard library only. The output directory is created, never deleted: under the grader it is the
// /output mount point and removing it would fail with EBUSY.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cp, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath as entryFile } from 'node:url';
import { buildDossier } from './vendor/makefun-frontend.ts';

const ROOT = dirname(entryFile(import.meta.url));

// The scorer's caps. These values are fixed: the scorer rebuilds dossier.json itself and compares byte for byte.
const LIMITS = {
  text_max_bytes: 163840,
  screenshots: { max: 3, max_bytes: 262144 },
  app_max_files: 993,
  app_max_bytes: 16777216,
} as const;

const SHOT_COUNT = 3;

const USAGE = `usage: node main.ts [--out <dir>] [-h|--help]

Copies app/ and screenshots/ into <dir> and writes <dir>/dossier.json.
<dir> comes from --out, else $MAKEFUN_OUTPUT_DIR, else /output; it is created when missing and never removed.

example:
  node main.ts --out ./dist
`;

/** A problem the user can fix: printed as one line, no stack trace. */
class EntryError extends Error {}

// --------------------------------------------------------------------------------------------- arguments

type Options = { help: boolean; out: string };

function parseArgs(argv: readonly string[]): Options {
  let help = false;
  let fromFlag: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;

    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }

    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) throw new EntryError('--out needs a directory after it');
      fromFlag = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (value === '') throw new EntryError('--out= needs a directory after it');
      fromFlag = value;
      continue;
    }

    if (arg.startsWith('-')) throw new EntryError(`unknown flag: ${arg}`);
    throw new EntryError(`unexpected argument: ${arg} (did you mean --out ${arg}?)`);
  }

  const chosen = fromFlag ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  return { help, out: resolve(chosen) };
}

// --------------------------------------------------------------------------------------------- shots.json

type Shot = { file: string; route: string; width: number; height: number };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Validates one shots.json entry against the screenshot it names; returns the facts the report prints. */
function checkShot(raw: unknown, index: number, shotDir: string): Shot {
  const where = `shots.json entry ${index + 1}`;

  const entry = asRecord(raw);
  if (entry === null) throw new EntryError(`${where}: not an object`);

  const file = asText(entry.file);
  if (file === null) throw new EntryError(`${where}: "file" is missing or not a name`);

  const route = asText(entry.path);
  if (route === null) throw new EntryError(`${where} (${file}): "path" is missing or not a route`);

  const viewport = asRecord(entry.viewport);
  if (viewport === null) throw new EntryError(`${where} (${file}): "viewport" is missing or not an object`);

  const width = asNumber(viewport.width);
  if (width === null) throw new EntryError(`${where} (${file}): "viewport.width" is not a number`);

  const height = asNumber(viewport.height);
  if (height === null) throw new EntryError(`${where} (${file}): "viewport.height" is not a number`);

  const onDisk = join(shotDir, file);
  if (!existsSync(onDisk)) throw new EntryError(`${where} (${file}): screenshots/${file} does not exist`);

  const bytes = statSync(onDisk).size;
  if (bytes >= LIMITS.screenshots.max_bytes) {
    throw new EntryError(`${where} (${file}): screenshots/${file} is ${bytes} bytes, at or over the ${LIMITS.screenshots.max_bytes} byte cap`);
  }

  return { file, route, width, height };
}

function readShots(shotDir: string): Shot[] {
  const listFile = join(ROOT, 'shots.json');
  if (!existsSync(listFile)) throw new EntryError('shots.json is missing from the entry directory');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(listFile, 'utf8'));
  } catch (err) {
    throw new EntryError(`shots.json is not valid JSON (${(err as Error).message})`);
  }

  if (!Array.isArray(parsed)) throw new EntryError('shots.json must hold an array of screenshots');
  if (parsed.length !== SHOT_COUNT) {
    throw new EntryError(`shots.json lists ${parsed.length} screenshot${parsed.length === 1 ? '' : 's'}; the entry needs exactly ${SHOT_COUNT}`);
  }

  return parsed.map((raw, i) => checkShot(raw, i, shotDir));
}

// --------------------------------------------------------------------------------------------- material

async function holdsAnyFile(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && (await holdsAnyFile(join(dir, entry.name)))) return true;
  }
  return false;
}

async function checkMaterial(): Promise<void> {
  const appDir = join(ROOT, 'app');
  if (!existsSync(appDir)) throw new EntryError('app/ is missing from the entry directory');
  if (!(await holdsAnyFile(appDir))) throw new EntryError('app/ holds no files');
  if (!existsSync(join(ROOT, 'vendor', 'makefun-frontend.ts'))) throw new EntryError('vendor/makefun-frontend.ts is missing');
}

/** Copies the static frontend and the captures over the output; existing files are overwritten. */
async function stage(outDir: string): Promise<void> {
  await cp(join(ROOT, 'app'), join(outDir, 'app'), { recursive: true, force: true });

  const captures = join(ROOT, 'screenshots');
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  if (existsSync(captures)) await cp(captures, join(outDir, 'screenshots'), { recursive: true, force: true });
}

// --------------------------------------------------------------------------------------------- report

/** The dossier's `Totals:` line: the summary lives in its JSON `text` field. */
function totalsOf(dossier: Uint8Array): string {
  let text = '';
  try {
    const parsed: unknown = JSON.parse(Buffer.from(dossier).toString('utf8'));
    if (asRecord(parsed) !== null) text = String((parsed as Record<string, unknown>).text ?? '');
  } catch {
    // A dossier that does not parse is the scorer's business, not this report's.
  }
  const found = text.split('\n').find((line) => line.startsWith('Totals:'));
  return found ?? 'Totals: (no Totals line in the dossier)';
}

function summarize(outDir: string, dossier: Uint8Array, shots: readonly Shot[]): void {
  console.log(`output:    ${outDir}`);
  console.log(`dossier:   ${dossier.byteLength} bytes`);
  for (const shot of shots) {
    const size = statSync(join(outDir, 'screenshots', shot.file)).size;
    console.log(`shot:      screenshots/${shot.file} ${size} bytes (${shot.width}x${shot.height} at ${shot.route})`);
  }
  console.log(totalsOf(dossier));
}

// --------------------------------------------------------------------------------------------- main

async function run(argv: readonly string[]): Promise<void> {
  const { help, out } = parseArgs(argv);
  if (help) {
    process.stdout.write(USAGE);
    return;
  }

  await checkMaterial();
  const shots = readShots(join(ROOT, 'screenshots'));

  mkdirSync(out, { recursive: true });
  await stage(out);

  const dossier = buildDossier(out, LIMITS);
  writeFileSync(join(out, 'dossier.json'), dossier);

  summarize(out, dossier, shots);
}

run(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`main.ts: ${message}\n`);
  if (err instanceof EntryError) process.stderr.write('run `node main.ts --help` for usage\n');
  process.exitCode = 1;
});


