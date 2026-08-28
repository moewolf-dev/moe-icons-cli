export const MAX_COLS: number;
export const MAX_ROWS: number;
export const V_SCALE: number;
export const LOGO_CHARS: readonly string[];
export class LogoGenerateError extends Error {}
export function parseArgv(argv: string[]): { input: string };
export function mapPixel(luma: number, alpha: number): string;
export function rasterToLines(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
): string[];
export function trimAscii(lines: string[]): string[];
export function generateLogoAscii(options: {
  input: string;
  output: string;
}): Promise<{ lines: string[]; source: string }>;
