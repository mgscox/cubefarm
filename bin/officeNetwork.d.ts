export function officeHost(env?: Record<string, string | undefined>): string;
export function localAddress(host: string): string;
export function localUrl(host: string, port: number, scheme?: string): string;
export function browserUrl(host: string, port: number): string;
export function bindMessage(host: string, port: number): string;
