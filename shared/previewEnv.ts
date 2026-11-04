// One size budget for a floor's preview environment, shared by the server and settings form.
export const PREVIEW_ENV_MAX_CHARS = 16_000;

/** Count names and values, excluding separators and formatting. */
export function previewEnvTooBig(env: Record<string, string>): boolean {
  return Object.entries(env).reduce((total, [name, value]) => total + name.length + value.length, 0) > PREVIEW_ENV_MAX_CHARS;
}
