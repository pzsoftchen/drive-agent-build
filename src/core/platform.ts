import { ValidationError } from './errors.ts';

export function assertSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    throw new ValidationError(
      'Windows is not supported in v0.1',
      'platform.unsupported',
      { hint: 'Use macOS or Linux. Windows junction support is planned for a later release.' },
    );
  }
}
