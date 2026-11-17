import { ExitCode } from './exit-codes.ts';

export interface DabErrorOptions {
  details?: unknown;
  hint?: string;
}

export class DabError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details: unknown;
  readonly hint: string | undefined;

  constructor(
    message: string,
    code: string,
    exitCode: ExitCode,
    options: DabErrorOptions = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    this.details = options.details;
    this.hint = options.hint;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      exitCode: this.exitCode,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export class UsageError extends DabError {
  constructor(message: string, code = 'usage.invalid', options: DabErrorOptions = {}) {
    super(message, code, ExitCode.Usage, options);
  }
}

export class ConfigError extends DabError {
  constructor(message: string, code = 'config.invalid', options: DabErrorOptions = {}) {
    super(message, code, ExitCode.Usage, options);
  }
}

export class ValidationError extends DabError {
  constructor(message: string, code = 'validation.failed', options: DabErrorOptions = {}) {
    super(message, code, ExitCode.Validation, options);
  }
}

export class BackendError extends DabError {
  constructor(message: string, code = 'backend.incompatible', options: DabErrorOptions = {}) {
    super(message, code, ExitCode.Backend, options);
  }
}
