export const ExitCode = {
  Ok: 0,
  Internal: 1,
  Usage: 2,
  Validation: 3,
  Backend: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
