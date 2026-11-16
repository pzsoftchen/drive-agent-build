import { spawn } from 'node:child_process';

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: CommandOptions,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(error);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => fail(error));
    child.on('close', (code) => {
      finish({ stdout, stderr, exitCode: code ?? 1 });
    });

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 100);
        killTimer.unref();
        finish({
          stdout,
          stderr: `${stderr}${stderr.length > 0 ? '\n' : ''}command timed out after ${opts.timeoutMs}ms`,
          exitCode: 124,
        });
      }, opts.timeoutMs);
    }

    child.stdin?.end(opts.input ?? '');
  });
