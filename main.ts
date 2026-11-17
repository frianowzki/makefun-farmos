// Entry builder for makefun-frontend-01 (Node 22, standard library only).
//
// `node main.ts` assembles what the judge reads:
//
//   <out>/app/            the static frontend, copied from app/ beside this file
//   <out>/screenshots/    the three dark captures, copied from screenshots/
//   <out>/dossier.json    written by buildDossier from vendor/makefun-frontend.ts
//
// The output directory is MAKEFUN_OUTPUT_DIR, or /output when that variable is unset — the
// judge's container mounts the result at /output and sets nothing, so the fallback is the path
// that matters. That directory is a mount point there, which is why this program only ever
// creates it when missing and overwrites files inside it: it never removes it, and never removes
// anything inside it either. `rmSync` on /output fails with EBUSY and the judge would read
// nothing back.
//
//   MAKEFUN_OUTPUT_DIR=/tmp/farmos-out node main.ts

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-frontend.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The caps the judge's gate.json applies; passing them here means this program fails wherever the
// judge would refuse the entry, instead of handing in something it cannot score.
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 3, max_bytes: 262144 },
  app_max_files: 993,
  app_max_bytes: 16777216,
};

/** Fail loudly rather than copy anything but a directory of this repository. */
function checked(name: string): string {
  const from = join(HERE, name);
  if (!existsSync(from)) throw new Error(`${from} is missing: the entry is built from this repository`);
  if (!statSync(from).isDirectory()) throw new Error(`${from} is not a directory`);
  return from;
}

mkdirSync(OUT, { recursive: true });
cpSync(checked('app'), join(OUT, 'app'), { recursive: true, force: true });
cpSync(checked('screenshots'), join(OUT, 'screenshots'), { recursive: true, force: true });

const dossier = buildDossier(OUT, CAPS);
writeFileSync(join(OUT, 'dossier.json'), dossier);

// What the judge will read, in the order it reads it, so the log is worth keeping.
const text = readFileSync(join(OUT, 'dossier.json'), 'utf8');
const doc = JSON.parse(text) as { images: { name: string; base64: string }[]; text: string };
const totals = doc.text.split('\n').find((line) => line.startsWith('Totals:')) ?? '(no Totals line)';
console.log(`output:      ${resolve(OUT)}`);
console.log(`dossier:     ${text.length} bytes, ${doc.images.length} images`);
for (const image of doc.images) console.log(`  ${image.name.padEnd(20)} ${Buffer.from(image.base64, 'base64').length} bytes`);
console.log(totals);
