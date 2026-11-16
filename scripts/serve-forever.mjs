// Starts serve.ts on a port in its own process, for a shell that has no tty to hand it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = process.argv[2] ?? '8129';
const here = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(process.execPath, ['serve.ts', '--port', String(port)], {
  cwd: here,
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
