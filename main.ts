// main.ts — hand this entry to the grader.
//
// What it does, in order:
//   1. parses its own arguments (--out <dir>, --help) and picks the output directory;
//   2. checks that shots.json names exactly the three screenshots this entry ships, that each file is really there,
//      really an image, and under the 256 KiB the judge allows — refusing, by name and reason, before anything is
//      copied, so a wrong screenshot never reaches the dossier;
//   3. creates the output directory (never deleting it: under Linux /output is a mount point, and removing a mount
//      point fails with EBUSY), copies app/ and screenshots/ over it, and writes dossier.json there with the
//      vendored buildDossier;
//   4. prints the output path, the dossier's byte size, each screenshot's size and the dossier's own Totals line.
//
// The dossier must be byte for byte what the scorer's copy of vendor/makefun-frontend.ts writes from the same files,
// so the caps handed to buildDossier are the scorer's own from its gate.json, unchanged: text_max_bytes shapes the
// bytes; the others make this program fail exactly where the scorer would.
//
// Node 22, standard library only, nothing installed:
//   node main.ts --out /absolute/path/outside/the/repo
//   MAKEFUN_OUTPUT_DIR=/absolute/path node main.ts
//
// The frontend is app/ — static files a browser opens at app/index.html, no build step. To look at it locally,
// `node serve.ts` and open http://localhost:8080.

import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier, type DossierCaps } from './vendor/makefun-frontend.ts';

/** Where the grader mounts this entry. Set MAKEFUN_OUTPUT_DIR or pass --out to write somewhere else. */
const DEFAULT_OUT = '/output';
/** Beside this file: app/, screenshots/, shots.json and the vendored library all live here. */
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');

/** The scorer's caps (reference/gate.json). A dossier built under any other caps is not the scorer's dossier. */
const CAPS: DossierCaps = {
  text_max_bytes: 163840,
  screenshots: { max: 3, max_bytes: 262144 },
  app_max_files: 993,
  app_max_bytes: 16777216,
};

/** shots.json must name this many screenshots: the cover and two more, the count the caps above allow. */
const SHOT_COUNT = 3;
/** The judge's byte cap on one screenshot (CAPS.screenshots.max_bytes), as the figure the report prints. */
const SHOT_MAX_BYTES = 262144;

/** A failure with a message written for a person: printed as is, and the run exits 1. */
class Failure extends Error {}

const USAGE = `Usage: node main.ts [--out <dir>]

Build makefun-frontend-01's dossier from app/ and screenshots/ and write it to <dir>/dossier.json.

Options:
  --out <dir>, --out=<dir>   write app/, screenshots/ and dossier.json into <dir> (beats MAKEFUN_OUTPUT_DIR)
  -h, --help                 print this text and exit

Output directory, highest precedence first: --out, then MAKEFUN_OUTPUT_DIR, then ${DEFAULT_OUT}.
It is created if missing and its contents are overwritten; it is never removed.

Example:
  node main.ts --out /tmp/makefun-entry
`;

interface Args {
  /** --out as given, or null: the environment variable is read later, by outputDir. */
  out: string | null;
  help: boolean;
}

/** Whether the flag still needs its value, given what follows it. */
const wantsValue = (next: string | undefined): boolean => next === undefined || (next.startsWith('-') && next !== '-');

/** Reads the flags. Anything this program does not know stops the run here, rather than being ignored. */
function parseArgs(argv: readonly string[]): Args {
  const args: Args = { out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // A bare '-' and everything after '--' are not flags.
    if (!arg.startsWith('-') || arg === '-' || arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag !== '--out') throw new Failure(`unknown flag ${flag}: main.ts takes --out <dir> and --help (node main.ts --help)`);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      const next = argv[i + 1];
      if (wantsValue(next)) throw new Failure('--out needs a directory: node main.ts --out <dir>');
      value = next!;
      i++;
    }
    if (value === '') throw new Failure('--out needs a directory: node main.ts --out <dir>');
    if (args.out !== null && args.out !== value) throw new Failure(`--out given twice, as ${args.out} and ${value}: pass it once`);
    args.out = value;
  }
  return args;
}

/** The output directory as an absolute, normalised path: --out, else MAKEFUN_OUTPUT_DIR, else /output. */
function outputDir(args: Args): string {
  const fromEnv = process.env.MAKEFUN_OUTPUT_DIR;
  const raw = args.out ?? (fromEnv === undefined || fromEnv === '' ? DEFAULT_OUT : fromEnv);
  try {
    return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
  } catch (err) {
    throw new Failure(`output directory ${JSON.stringify(raw)} is not a usable path (${(err as Error).message})`);
  }
}

/** True when path is dir itself or sits under it (case-insensitively: a Windows path may differ in case). */
function sameOrInside(path: string, dir: string): boolean {
  const a = resolve(path).toLowerCase();
  const b = resolve(dir).toLowerCase();
  if (a === b) return true;
  const rel = relative(b, a).toLowerCase();
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** One screenshot: what shots.json says of it, and what the file itself turned out to be. */
interface Shot {
  file: string;
  path: string;
  width: number;
  height: number;
  bytes: number;
  media: 'PNG' | 'JPEG';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
const opensWith = (bytes: Uint8Array, magic: readonly number[]): boolean => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

/**
 * Reads shots.json and every screenshot it names, before anything is copied. Each entry needs a `file`, a `path` and a
 * `viewport` with a width and a height; the file must exist under screenshots/, open with the PNG or JPEG magic the
 * judge reads, and be no bigger than its cap. No file may be named twice, nor shipped without being named: the dossier
 * counts every image in screenshots/, so an unnamed one would be a fourth screenshot it never heard of.
 */
function checkShots(out: string): Shot[] {
  const shotsJson = join(HERE, 'shots.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(shotsJson, 'utf8'));
  } catch (err) {
    throw new Failure(`shots.json: cannot be read as JSON from ${shotsJson} (${(err as Error).message})`);
  }
  if (!Array.isArray(raw)) throw new Failure('shots.json: must be an array of screenshot entries');
  if (raw.length !== SHOT_COUNT) {
    throw new Failure(`shots.json: names ${raw.length} screenshot${raw.length === 1 ? '' : 's'}, and an entry hands in exactly ${SHOT_COUNT}`);
  }

  const shotsDir = join(HERE, 'screenshots');
  let dir;
  try {
    dir = statSync(shotsDir);
  } catch {
    throw new Failure(`no screenshots/ directory beside main.ts (expected ${shotsDir})`);
  }
  if (!dir.isDirectory()) throw new Failure(`screenshots beside main.ts is not a directory (${shotsDir})`);

  const named = new Set<string>();
  const shots = raw.map((entry: unknown, at: number): Shot => {
    const where = `shots.json[${at}]`;
    if (!isObject(entry)) throw new Failure(`${where}: must be an object {file, path, viewport}`);
    if (!('file' in entry)) throw new Failure(`${where}: has no "file"`);
    if (!('path' in entry)) throw new Failure(`${where}: has no "path"`);
    if (!('viewport' in entry)) throw new Failure(`${where}: has no "viewport"`);

    const { file, path, viewport } = entry as { file: unknown; path: unknown; viewport: unknown };
    if (typeof file !== 'string' || file === '') throw new Failure(`${where}.file: must be a non-empty string`);
    if (typeof path !== 'string' || path === '') throw new Failure(`${where} (${file}).path: must be the non-empty route the screenshot was taken at`);
    if (!isObject(viewport)) throw new Failure(`${where} (${file}).viewport: must be an object {width, height}`);
    if (!isSize(viewport.width) || !isSize(viewport.height)) {
      throw new Failure(`${where} (${file}).viewport: needs a whole-number width and height, not ${JSON.stringify(viewport)}`);
    }
    if (file.includes('/') || file.includes('\\') || file.startsWith('.')) {
      throw new Failure(`${where}.file ${JSON.stringify(file)}: must be a bare file name under screenshots/, not a path`);
    }
    if (named.has(file)) throw new Failure(`${where}.file: ${file} is named more than once`);
    named.add(file);

    const abs = join(shotsDir, file);
    if (sameOrInside(abs, out)) {
      throw new Failure(`screenshots/${file}: sits inside the output directory ${out}, which would copy it into itself`);
    }
    let file_ = null;
    try {
      file_ = statSync(abs);
    } catch {
      throw new Failure(`screenshots/${file}: named by shots.json but not there (expected ${abs})`);
    }
    if (!file_.isFile()) throw new Failure(`screenshots/${file}: not a regular file`);
    if (file_.size > SHOT_MAX_BYTES) {
      throw new Failure(`screenshots/${file}: ${file_.size} bytes, over the judge's ${SHOT_MAX_BYTES}-byte cap`);
    }
    const bytes = readFileSync(abs);
    const png = opensWith(bytes, [0x89, 0x50, 0x4e]);
    const jpeg = opensWith(bytes, [0xff, 0xd8, 0xff]);
    if (!png && !jpeg) {
      throw new Failure(`screenshots/${file}: ${bytes.length} bytes, but neither PNG nor JPEG (opens with ${hex(bytes.subarray(0, 3))}); the judge reads only those two`);
    }
    return { file, path, width: viewport.width, height: viewport.height, bytes: bytes.length, media: png ? 'PNG' : 'JPEG' };
  });

  const shipped = readdirSync(shotsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  const unnamed = shipped.filter((name) => !named.has(name));
  if (unnamed.length > 0) {
    throw new Failure(`screenshots/ holds ${shipped.length} image${shipped.length === 1 ? '' : 's'}, ${unnamed.length} unnamed by shots.json (${unnamed.join(', ')})`);
  }
  return shots;
}

/** True when the path can be stat'd at all. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Copies app/ and screenshots/ into the output directory, creating it and never removing it. */
function copyEntry(out: string): void {
  const index = join(HERE, 'app', 'index.html');
  if (!exists(index)) throw new Failure(`app/index.html: not found (${index}); that page is what the judge opens`);
  try {
    mkdirSync(out, { recursive: true });
    cpSync(join(HERE, 'app'), join(out, 'app'), { recursive: true, force: true });
    mkdirSync(join(out, 'screenshots'), { recursive: true });
    cpSync(join(HERE, 'screenshots'), join(out, 'screenshots'), { recursive: true, force: true });
  } catch (err) {
    throw new Failure(`cannot copy app/ and screenshots/ into ${out} (${(err as Error).message})`);
  }
}

/** Builds the dossier from the output directory and writes it there; returns the bytes written. */
function writeDossier(out: string): Uint8Array {
  let dossier: Uint8Array;
  try {
    dossier = buildDossier(out, CAPS);
  } catch (err) {
    throw new Failure(`buildDossier refused ${out}: ${(err as Error).message}`);
  }
  const file = join(out, 'dossier.json');
  try {
    writeFileSync(file, dossier);
  } catch (err) {
    throw new Failure(`cannot write ${file} (${(err as Error).message})`);
  }
  return dossier;
}

/** The dossier's `Totals:` line, read back out of the bytes actually written. */
function totalsLine(dossier: Uint8Array): string {
  const doc = JSON.parse(Buffer.from(dossier).toString('utf8')) as { text?: unknown };
  const text = typeof doc.text === 'string' ? doc.text : '';
  return text.split('\n').find((line) => line.startsWith('Totals:')) ?? '(the dossier has no Totals line)';
}

/** The report printed on success. */
function report(out: string, dossier: Uint8Array, shots: readonly Shot[]): void {
  const bytes = (n: number): string => n.toLocaleString('en-US');
  const lines = [
    `wrote ${join(out, 'dossier.json')}`,
    `  dossier.json  ${bytes(dossier.length)} bytes`,
    `  screenshots   ${shots.length} in ${join(out, 'screenshots')}`,
    ...shots.map((s) => `                ${s.file}  ${bytes(s.bytes)} bytes  ${s.media} ${s.width}x${s.height}  ${s.path}`),
    `  app           ${join(out, 'app')}`,
    `  ${totalsLine(dossier)}`,
  ];
  console.log(lines.join('\n'));
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const out = outputDir(args);
  const shots = checkShots(out);
  copyEntry(out);
  const dossier = writeDossier(out);
  report(out, dossier, shots);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  // Always one readable line: a Failure's own message, or the sentence an unexpected error carries.
  console.error(`main.ts: ${err instanceof Failure ? err.message : `unexpected failure: ${err instanceof Error ? err.message : String(err)}`}`);
  process.exitCode = 1;
}
