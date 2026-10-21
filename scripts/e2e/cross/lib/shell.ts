/**
 * Process helpers: run a command to completion, or start a long-lived one
 * detached in its own process group (so `--keep-up` stacks survive the runner
 * and `--down` can stop them later by pid).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export async function run(cmd: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn([...cmd], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 300_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Run and throw with the command's output on a non-zero exit. */
export async function runOrThrow(cmd: readonly string[], opts: RunOptions = {}): Promise<string> {
  const res = await run(cmd, opts);
  if (res.code !== 0) {
    const tail = `${res.stdout}\n${res.stderr}`.trim().split('\n').slice(-15).join('\n');
    throw new Error(`\`${cmd.join(' ')}\` exited ${res.code}:\n${tail}`);
  }
  return res.stdout;
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Start `cmd` detached (own process group, stdout+stderr to `logFile`) and
 * return its pid. The child keeps running after this process exits.
 */
export async function spawnDetached(
  cmd: readonly string[],
  opts: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly logFile: string;
  },
): Promise<number> {
  const exports = Object.entries(opts.env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)};`)
    .join(' ');
  // No nohup: macOS nohup exits ("can't detach from console") outside a console
  // session. `set -m` already puts the job in its own process group.
  const script = `set -m; cd ${shellQuote(opts.cwd)}; ${exports} ${cmd
    .map(shellQuote)
    .join(' ')} > ${shellQuote(opts.logFile)} 2>&1 < /dev/null & echo $!`;
  const out = await runOrThrow(['sh', '-c', script]);
  const pid = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(pid)) throw new Error(`could not start ${cmd.join(' ')}: ${out}`);
  return pid;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the process group, then SIGKILL whatever is left after `graceMs`. */
export async function stopGroup(pid: number, graceMs = 5_000): Promise<void> {
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  if (isAlive(pid)) signal('SIGKILL');
}

/** Pids of the processes the harness started, persisted across runs. */
export class PidFile {
  private readonly file: string;

  constructor(artifactsDir: string) {
    this.file = join(artifactsDir, 'pids.json');
  }

  read(): Readonly<Record<string, number>> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, number>;
  }

  set(name: string, pid: number): void {
    writeFileSync(this.file, JSON.stringify({ ...this.read(), [name]: pid }, null, 2));
  }

  remove(name: string): void {
    const { [name]: _removed, ...rest } = this.read();
    writeFileSync(this.file, JSON.stringify(rest, null, 2));
  }
}

/** Is anything listening on localhost:`port`? */
export async function portInUse(port: number): Promise<boolean> {
  const res = await run(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return res.stdout.trim().length > 0;
}
