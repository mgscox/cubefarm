// Types for e2eSteps.mjs (plain JavaScript, like the other scripts/ steps modules).

type Env = Record<string, string | undefined>;
export function e2eBrowser(env: Env, chromeInstalled: boolean): 'chrome' | 'chromium';
export function webServerCommand(env: Env, hasBuild: boolean): string;
export function chromeInstalled(): boolean;
