export function readOfficeCredential(home: string, filename: string, validToken: (value: unknown) => boolean): { token: string } | null;
export function writeOfficeCredential(home: string, filename: string, token: string | null): void;
