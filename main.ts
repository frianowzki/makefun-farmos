// FarmOS ships as static files: app/ is the frontend, screenshots/ the three captures of it running.
// This program stages both into the directory a grader mounts as /output and writes dossier.json beside them,
// the summary the judge reads (its screenshots, the first load's files and bytes, and the app's source).
//
//   node main.ts                                  # writes /output
//   node main.ts --out ./out                      # or --out=<dir>, or $MAKEFUN_OUTPUT_DIR
//   MAKEFUN_OUTPUT_DIR=/tmp/farmos node main.ts
//
// The output directory is created when it is missing and written over when it is there. It is never removed:
// under Linux /output is a mount point, and rmdir on one fails with EBUSY. vendor/makefun-frontend.ts is the
// kit's own copy of the dossier library, untouched; the scorer rebuilds the dossier with it and compares bytes.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier, DossierError } from './vendor/makefun-frontend.ts';

/** The directory this file sits in: every path below is found from here, never from the working directory. */
const REPO = dirname(fileURLToPath(import.meta.url));

/** The scorer's own caps (reference/gate.json), written into the dossier byte for byte. */
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 3, max_bytes: 262144 },
  app_max_files: 993,
  app_max_bytes: 16777216,
};

/** Where a run writes when nobody says otherwise: the grader's mount. */
const DEFAULT_OUT = '/output';

const USAGE = `FarmOS: stage app/ and screenshots/ and write dossier.json.

  node main.ts [--out <dir>]

  --out <dir>   the directory to write app/, screenshots/ and dossier.json into
                (--out=<dir> works too; $MAKEFUN_OUTPUT_DIR is read when neither is given;
                with nothing at all it is ${DEFAULT_OUT}, where the grader mounts the entry)
  -h, --help    this text

example:
  node main.ts --out ./out && ls out/app out/screenshots out/dossier.json
`;

/** A failure worth a sentence and an exit code, never a stack trace. */
class BuildError extends Error {}

/** The command line: an output directory, or the help. An unknown flag stops the run. */
function readArgs(argv) {
  let out = null;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) throw new BuildError('--out needs a directory after it: node main.ts --out ./out');
      out = value;
      i++;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (value === '') throw new BuildError('--out= needs a directory after it: node main.ts --out=./out');
      out = value;
    } else if (arg.startsWith('-')) {
      throw new BuildError(`unknown flag ${arg}. Try node main.ts --help`);
    } else {
      throw new BuildError(`unexpected argument ${arg}: the only argument is --out <dir>. Try node main.ts --help`);
    }
  }
  if (help) return { help: true, out: null };
  const fromEnv = process.env.MAKEFUN_OUTPUT_DIR;
  const chosen = out ?? (fromEnv && fromEnv.trim() !== '' ? fromEnv : DEFAULT_OUT);
  return { help: false, out: resolve(REPO, chosen) };
}

/** Every file under `from`, as paths relative to it, deepest first: a recursive copy that never follows a link. */
function walk(from) {
  const found = [];
  const visit = (rel) => {
    const here = rel === '' ? from : join(from, rel);
    for (const entry of readdirSync(here, { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        found.push({ path, dir: true });
        visit(path);
      } else if (entry.isFile()) {
        found.push({ path, dir: false });
      } else {
        throw new BuildError(`${join(from, path)}: a symbolic link or special file, which an entry never ships`);
      }
    }
  };
  visit('');
  return found;
}

/** Copies one tree into the output, creating each directory on the way and overwriting each file. */
function stage(from, into, label) {
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new BuildError(`no ${label}/ directory beside main.ts`);
  // The destination tree's own root, so a file at its top level has somewhere to land.
  mkdirSync(into, { recursive: true });
  for (const item of walk(from)) {
    const target = join(into, ...item.path.split('/'));
    if (item.dir) mkdirSync(target, { recursive: true });
    else copyFileSync(join(from, ...item.path.split('/')), target);
  }
}

/** shots.json's contract, checked before a single byte is written: three captures, each named, routed and sized. */
function checkShots() {
  const file = join(REPO, 'shots.json');
  if (!existsSync(file)) throw new BuildError('shots.json is missing: it names the three screenshots of the app');
  let shots;
  try {
    shots = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new BuildError(`shots.json is not JSON (${err.message})`);
  }
  if (!Array.isArray(shots)) throw new BuildError('shots.json holds a list of three screenshots');
  if (shots.length !== 3) throw new BuildError(`shots.json names ${shots.length} screenshots; an entry hands in exactly 3`);
  const seen = new Set();
  return shots.map((shot, index) => {
    const where = `shots.json[${index}]`;
    if (typeof shot !== 'object' || shot === null) throw new BuildError(`${where} is not an object`);
    for (const key of ['file', 'path']) {
      if (typeof shot[key] !== 'string' || shot[key].trim() === '') throw new BuildError(`${where}.${key} must be a non-empty string`);
    }
    const view = shot.viewport;
    if (typeof view !== 'object' || view === null) throw new BuildError(`${where}.viewport must be {width, height}`);
    for (const side of ['width', 'height']) {
      if (typeof view[side] !== 'number' || !Number.isFinite(view[side]) || view[side] <= 0) {
        throw new BuildError(`${where}.viewport.${side} must be a positive number`);
      }
    }
    if (seen.has(shot.file)) throw new BuildError(`${where}.file names ${shot.file} twice`);
    seen.add(shot.file);
    const image = join(REPO, 'screenshots', shot.file);
    if (!existsSync(image) || !statSync(image).isFile()) throw new BuildError(`${where}.file: screenshots/${shot.file} does not exist`);
    const size = statSync(image).size;
    if (size > CAPS.screenshots.max_bytes) {
      throw new BuildError(`screenshots/${shot.file} is ${size} bytes, over the ${CAPS.screenshots.max_bytes} an image may be`);
    }
    return { file: shot.file, path: shot.path, width: view.width, height: view.height, bytes: size };
  });
}

/** The Load block's Totals: line, out of the dossier the library built. */
function totalsLine(dossierBytes) {
  const dossier = JSON.parse(Buffer.from(dossierBytes).toString('utf8'));
  const line = String(dossier.text || '').split('\n').find((text) => text.startsWith('Totals:'));
  return line ?? '(the dossier has no Totals line)';
}

function build(argv) {
  const args = readArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const shots = checkShots();

  mkdirSync(args.out, { recursive: true });
  stage(join(REPO, 'app'), join(args.out, 'app'), 'app');
  stage(join(REPO, 'screenshots'), join(args.out, 'screenshots'), 'screenshots');

  let dossier;
  try {
    dossier = buildDossier(args.out, CAPS);
  } catch (err) {
    if (err instanceof DossierError) throw new BuildError(`the dossier library refused this entry${err.limit ? ` (${err.limit})` : ''}: ${err.message}`);
    throw err;
  }
  writeFileSync(join(args.out, 'dossier.json'), dossier);

  const lines = [
    `FarmOS: staged into ${args.out}`,
    `  dossier.json  ${dossier.length} bytes`,
    ...shots.map((shot) => `  screenshots/${shot.file}  ${shot.bytes} bytes  (${shot.width}×${shot.height}, ${shot.path})`),
    `  ${totalsLine(dossier)}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

try {
  process.exitCode = build(process.argv.slice(2));
} catch (err) {
  const said = err instanceof BuildError || err instanceof DossierError ? err.message : `${err && err.message ? err.message : err}`;
  process.stderr.write(`main.ts: ${said}\n`);
  process.exitCode = 1;
}
