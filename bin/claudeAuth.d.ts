export function claudeEnv(inherited?: NodeJS.ProcessEnv, options?: { login?: boolean; demo?: boolean; sessionToken?: string }): Record<string, string>;
export function validClaudeToken(token: unknown): token is string;
export function saveClaudeToken(home: string, token: string, demo?: boolean): Promise<void>;
export function claudeAuthMetadata(env?: NodeJS.ProcessEnv, demo?: boolean): { source: 'demo' | 'saved' | 'startup' | 'cli'; expiresAt: null };
