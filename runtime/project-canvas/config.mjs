import { readFileSync } from 'node:fs';

export const DEFAULT_PORT = 4317;
export function serverPort() {
  const value = Number(process.env.PORT || DEFAULT_PORT);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('PORT 必须是 1–65535 之间的整数。');
  return value;
}
export const APP_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
