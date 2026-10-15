/** Stops exactly the process groups global-setup started (by PID, never by name). */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { STATE_FILE } from './stack.ts';

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  const { pids } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { pids: number[] };
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGTERM'); // the child's own process group
    } catch {
      // already gone
    }
  }
  rmSync(STATE_FILE, { force: true });
}
