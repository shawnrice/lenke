// One command to run the whole demo: the WebSocket server AND the Vite dev
// server, together. The frontend is inert on its own — every cluster's rows are
// demand-filled by querying the server, so with no server running the table
// just sits on "loading…". Running both here is what makes `npm run dev` (or
// `node dev.ts`) Just Work. Ctrl-C stops both; if either exits, the other is
// torn down too.
import { spawn, type ChildProcess } from 'node:child_process';

const procs: ChildProcess[] = [
  spawn('node', ['server.ts'], { stdio: 'inherit' }),
  spawn('vite', [], { stdio: 'inherit', shell: true }),
];

let stopping = false;
const stopAll = (): void => {
  if (stopping) {
    return;
  }

  stopping = true;

  for (const p of procs) {
    p.kill('SIGTERM');
  }
};

for (const p of procs) {
  p.on('exit', (code) => {
    stopAll();
    process.exit(code ?? 0);
  });
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
