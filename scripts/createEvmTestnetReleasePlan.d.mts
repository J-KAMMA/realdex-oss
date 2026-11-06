// The generator is plain JavaScript so it can run from node with no build step.
// This declares only what TypeScript callers use, so a test can compare the
// pinned profile against the release this tree actually builds.
export declare function createEvmTestnetReleasePlan(): Promise<{
  releaseId: string;
  source: { bundleSha256: string };
}>;
export declare const RELEASE_SOURCE_PATHS: readonly string[];
