/** Read-only hashing helpers; not key signing or a substitute for an audit. */
export declare function fromHex(value: string): Uint8Array;
export declare function toHex(bytes: Uint8Array): string;
export declare function keccak256(input: string | Uint8Array): string;
export declare function selector(signature: string): string;
export declare function address(value: string, allowZero?: boolean): string;
