export function selectedStore(env: Readonly<Record<string,string|undefined>>): {mode:"system"|"none"|"file";rootDir?:string};
export function rememberFileStore(env: Readonly<Record<string,string|undefined>>,rootDir:string): void;
export function stateRoot(env: Readonly<Record<string,string|undefined>>): string;
export function missingCredential(platform:string,error: {code?:unknown;status?:unknown;stderr?:unknown}): boolean;
