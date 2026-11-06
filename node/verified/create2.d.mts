/** Arithmetic only, not contract/deployment authentication or execution permission. */
export declare function deriveCreate2Address(factory: string, salt: string, initCode: string): string;
export declare function deriveLocalPoolAddress(input: {chainId: string; factory: string; tokenA: string; tokenB: string; feeBps: number; poolCreationCode: string}):
  Readonly<{schema: 'realdex.create2-derivation.v1'; chainId: string; factory: string; token0: string; token1: string; feeBps: number;
  expectedPool: string; salt: string; initCodeHash: string; creationCodeAuthenticated: false; deploymentProven: false; executable: false}>;
