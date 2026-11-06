/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Two defects found on 2026-09-04 lived in this screen's own state handling and
// could only be caught by driving the real screen: a memo that never recomputed
// when the target pool changed, and a comparison table that survived a
// configuration change and relabelled every row. No module-level test could see
// them, because neither was wrong about anything a module does.
//
// So the chain is faked and the screen is real. `Contract` answers by method
// name, discovery and the quote engine are stubbed at their module boundary, and
// everything between them — which is where those defects were — runs as shipped.

const CHAIN_ID = 31337n;
const POOL = "0x667bb2D062A4c4031a2Ef2C6166e172503620bf0";
const TOKEN_A = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TOKEN_B = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const FACTORY = "0x0165878A594ca255338adfa4d48449f69242Eb8F";
const ROUTER = "0x67d269191c92Caf3cD7723F116c85e6E9bf55933";
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const answers: Record<string, unknown> = {
  token0: TOKEN_B,
  token1: TOKEN_A,
  getReserves: [10_000n * 10n ** 18n, 20_000n * 10n ** 18n, 0n],
  totalSupply: 14_142n * 10n ** 18n,
  balanceOf: 1_000n * 10n ** 18n,
  feeBasisPoints: 1n,
  factory: FACTORY,
  decimals: 18n,
  allowance: 0n
};

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  class FakeContract {
    constructor (public address: string) {
      return new Proxy(this, {
        get: (target, property: string) => {
          if (property === "address") return target.address;
          return async () => {
            if (property === "symbol") return target.address === TOKEN_A ? "AMBR" : "JADE";
            if (property === "name") return target.address === TOKEN_A ? "Demo Amber" : "Demo Jade";
            if (property === "getPool") return POOL;
            if (property in answers) return answers[property];
            throw new Error(`unexpected contract call: ${property}`);
          };
        }
      });
    }
  }
  class FakeJsonRpcProvider {
    constructor (public url: string) {}
    async getNetwork () { return { chainId: CHAIN_ID }; }
    async getCode () { return "0x6001"; }
    destroy () {}
  }
  return { ...actual, Contract: FakeContract, JsonRpcProvider: FakeJsonRpcProvider };
});

vi.mock("./swap/evm-venue-discovery", async () => {
  const actual = await vi.importActual<typeof import("./swap/evm-venue-discovery")>("./swap/evm-venue-discovery");
  return {
    ...actual,
    createBrowserEvmVenueDiscoveryClient: () => ({}),
    createCachingEvmVenueDiscoveryClient: (inner: unknown) => inner,
    discoverLocalAmmVenues: async () => ({
      routes: [route("cheap"), route("dear")],
      feeBasisPointsByRouteId: new Map([["cheap", 1], ["dear", 30]]),
      rejected: []
    })
  };
});

vi.mock("./swap/evm-multihop", async () => {
  const actual = await vi.importActual<typeof import("./swap/evm-multihop")>("./swap/evm-multihop");
  return { ...actual, discoverEvmMultiHopRoutes: async () => ({ routes: [], paths: new Map(), rejected: [] }) };
});

// Two tiers for one pair, holding books at different share-per-reserve ratios.
// The ratios must differ: seeded at the geometric mean they mint the same number
// of shares for the same deposit, and a screen reading the wrong pool would look
// correct. That is exactly how this defect survived its first fix.
const DEEP_POOL = "0x9D9ED204bB3D8E9019AbB4E8e7E066b29E37a41d";
const one = (value: string) => BigInt(value) * 10n ** 18n;
const TIERS = [
  { pool: POOL, feeBasisPoints: 1, reserve0: one("10000"), reserve1: one("20000"), totalSupply: one("14142"), lpBalance: one("14142") },
  { pool: DEEP_POOL, feeBasisPoints: 30, reserve0: one("220000"), reserve1: one("363900"), totalSupply: one("282971"), lpBalance: one("100000") }
];

vi.mock("./swap/read-pool-tiers", () => ({
  createBrowserPoolTierReader: () => ({}),
  readPoolTiers: async () => TIERS
}));

vi.mock("./routing/engine", async () => {
  const actual = await vi.importActual<typeof import("./routing/engine")>("./routing/engine");
  return {
    ...actual,
    quoteRoutes: async () => ({ quotes: [quote("dear", 2_000n), quote("cheap", 1_800n)], rejected: [] }),
    executeRouteQuote: async () => { throw new Error("not executed in this test"); }
  };
});

// A reviewed bridge that starts where this chain's pool ends. The real registry
// only carries USDC, which none of the deployed pools hold — see V02_SCOPE.
const ARBITRUM_USDC = "eip155:421614/erc20:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
vi.mock("./routing/registry", () => ({
  ROUTE_DESCRIPTORS: [{
    id: "bridge-jade-arbitrum", revision: 1, operation: "bridge", adapterId: "cctp-v2",
    sourceAsset: `eip155:31337/erc20:${TOKEN_B}`, destinationAsset: ARBITRUM_USDC,
    state: "ready", walletCapabilityIds: ["eip1193"], sourceExecutionTarget: POOL,
    executionMethod: "BridgeKit.bridge", maximumQuoteTtlMs: 120_000, finalityTracking: "partial",
    trustBoundary: "test bridge", evidenceUrls: ["https://example.invalid/bridge"]
  }]
}));

function route (id: string) {
  return {
    id, revision: 1, operation: "swap", adapterId: "evm-local-amm",
    sourceAsset: `eip155:31337/erc20:${TOKEN_A}`, destinationAsset: `eip155:31337/erc20:${TOKEN_B}`,
    state: "ready", walletCapabilityIds: ["eip1193"], sourceExecutionTarget: POOL,
    executionMethod: "swapExactIn", maximumQuoteTtlMs: 120_000, finalityTracking: "tracked",
    trustBoundary: "test", evidenceUrls: ["https://example.invalid/test"]
  } as never;
}

function quote (routeId: string, minimumOut: bigint) {
  return {
    quoteId: `quote:${routeId}`, routeId, executionIntentId: "intent",
    expectedOutBaseUnits: minimumOut * 10n ** 15n, minimumOutBaseUnits: minimumOut * 10n ** 15n,
    expiresAt: Date.now() + 120_000, priceImpactBps: 0, feeBasisPoints: 1,
    unpricedCosts: [], feeBreakdown: [], protocolFeeBasisPoints: 0,
    authorization: { type: "approval", amountBaseUnits: 1_000n * 10n ** 18n, spender: POOL },
    adapterData: { format: "test", value: {} }
  } as never;
}

// The screen reads its stored configuration once, at module scope. Setting this
// inside a test would be too late — the module has already been evaluated and the
// screen comes up with nothing configured, which is not obviously distinguishable
// from a broken fake. This cost a run to find.
const INITIAL_CONFIG = {
  rpcUrl: "http://127.0.0.1:8545", chainId: "31337",
  factoryAddress: FACTORY, additionalFactories: "", feeTiers: "1, 30",
  routerAddress: ROUTER, intermediateTokens: "",
  poolAddress: POOL, tokenAAddress: TOKEN_A, tokenBAddress: TOKEN_B
};
localStorage.setItem("localswap-config", JSON.stringify(INITIAL_CONFIG));

const RECOVERY_HASH = "0x" + "b".repeat(64);
const FOREIGN_RECORD = {
  schema: "localswap.evm-swap-recovery.v1", recoveryId: "fnv1a:12345678", executionId: "evm:" + RECOVERY_HASH,
  routeId: "route", routeFingerprint: "fnv1a:23456789", quoteId: "quote", requestFingerprint: "fnv1a:3456789a",
  chainId: "eip155:8453", accountId: "eip155:8453:0x4000000000000000000000000000000000000004",
  recipient: "0x4000000000000000000000000000000000000004",
  source: { assetType: "eip155:8453/erc20:0x2000000000000000000000000000000000000002", symbol: "TKA", decimals: 6, amountBaseUnits: "1000000" },
  destination: { assetType: "eip155:8453/erc20:0x3000000000000000000000000000000000000003", symbol: "TKB", decimals: 6, minimumOutBaseUnits: "895500" },
  executionTarget: "0x1000000000000000000000000000000000000001", executionMethod: "swapExactIn",
  provider: "RealDEX Pool v1", stage: "swap-submitted",
  transactions: [{ role: "swap", hash: RECOVERY_HASH, state: "submitted", blockNumber: null, blockHash: null, confirmations: null }],
  requiredConfirmations: 2, revision: 1, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000
};
localStorage.setItem("localswap:evm-swap-recovery-journal:v1", JSON.stringify({
  schema: "localswap.evm-swap-recovery-journal.v1", records: [FOREIGN_RECORD]
}));

const { default: App } = await import("./App");

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
// Recovery tests deliberately write an unresolved same-pair record. Do not let
// that safety lock leak into later quote/fee-tier tests, or weaken the runtime
// lock to make those tests pass. Each case starts from the original fixture.
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("localswap-config", JSON.stringify(INITIAL_CONFIG));
  localStorage.setItem("localswap:evm-swap-recovery-journal:v1", JSON.stringify({
    schema: "localswap.evm-swap-recovery-journal.v1", records: [FOREIGN_RECORD]
  }));
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; container?.remove(); container = undefined;
});

const setValue = (element: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};
const button = (label: string) => [...container!.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
const labelled = (text: string) => [...container!.querySelectorAll("input")].find(item => (item.closest("label")?.textContent ?? "").includes(text));
const press = async (element: Element | null | undefined) => {
  await act(async () => { element?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
};
// Quotes deliberately debounce for 250 ms. Counting zero-delay event-loop turns
// can stop before that timer fires on fast CI runners; use a real bounded wait
// and fail at the unmet condition instead of silently continuing the test.
const settle = async (until: () => boolean, timeoutMs = 2_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!until() && performance.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(until(), "the screen did not reach the requested state within the bounded wait").toBe(true);
};

async function connectWallet () {
  const provider = {
    isMetaMask: true,
    on: () => {}, removeListener: () => {},
    request: async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCOUNT];
      if (method === "eth_chainId") return "0x7a69";
      throw new Error(`unexpected wallet call: ${method}`);
    }
  };
  const detail = Object.freeze({ info: { uuid: "00000000-0000-4000-8000-000000000001", name: "TEST WALLET", rdns: "io.metamask", icon: "data:image/svg+xml,<svg/>" }, provider });
  await act(async () => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    await Promise.resolve();
  });
  await press(button("Connect selected wallet") ?? button("Connect wallet"));
}

describe("a walk that stopped part way", () => {
  // The screen reads a stopped walk out of storage. The record it reads keeps a
  // summary and no receipts, so this exercises the reading-back path, not the
  // in-memory one.
  const swapLeg = {
    id: "cheap", revision: 1, operation: "swap" as const, adapterId: "evm-local-amm",
    sourceAsset: `eip155:31337/erc20:${TOKEN_A}`, destinationAsset: `eip155:31337/erc20:${TOKEN_B}`,
    state: "ready" as const, walletCapabilityIds: ["eip1193"], sourceExecutionTarget: POOL,
    executionMethod: "swapExactIn", maximumQuoteTtlMs: 120_000, finalityTracking: "tracked" as const,
    trustBoundary: "test", evidenceUrls: ["https://example.invalid/test"]
  };

  const clearWalks = () => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("localswap:route-plan-progress:")) localStorage.removeItem(key);
    }
  };

  const seedWalk = async (legs: Array<{ receiptState: "pending" | "confirmed" | "failed" | "unknown"; settled: boolean }>) => {
    const { findRoutePlans } = await import("./routing/plan");
    const { ROUTE_DESCRIPTORS } = await import("./routing/registry");
    const [plan] = findRoutePlans(
      { sourceAsset: swapLeg.sourceAsset, destinationAsset: ARBITRUM_USDC, amountInBaseUnits: 1n },
      [swapLeg, ...ROUTE_DESCRIPTORS]
    );
    expect(plan, "the fixture no longer produces a plan").toBeTruthy();
    clearWalks();
    const { routePlanProgressKey } = await import("./routing/plan-progress");
    const { routeDescriptorFingerprint } = await import("./routing/engine");
    const record = {
      schema: "realdex.route-plan-progress.v1",
      progressKey: routePlanProgressKey(plan.planId),
      planId: plan.planId,
      sourceAsset: plan.sourceAsset,
      destinationAsset: plan.destinationAsset,
      amountInBaseUnits: "1",
      legFingerprints: plan.legs.map((leg) => routeDescriptorFingerprint(leg)),
      legs: legs.map((leg, index) => ({
        legIndex: index,
        routeFingerprint: routeDescriptorFingerprint(plan.legs[index]),
        quoteId: `quote-${index}`,
        receiptState: leg.receiptState,
        settled: leg.settled
      })),
      updatedAt: 1_700_000_000_000
    };
    localStorage.setItem(record.progressKey, JSON.stringify(record));
  };

  const render = async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); });
    await settle(() => Boolean(container?.querySelector("select[aria-label='Destination on another chain']")));
    await press(container!.querySelector("button[aria-label='Reverse token direction']"));
    const select = container!.querySelector("select[aria-label='Destination on another chain']") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, ARBITRUM_USDC);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await settle(() => Boolean(container?.querySelector(".route-plan, .route-walk")));
  };

  it("calls holding the intermediate asset a position, not a failure", async () => {
    await seedWalk([{ receiptState: "confirmed", settled: true }, { receiptState: "failed", settled: false }]);
    await render();
    const walk = container!.querySelector(".route-walk");
    expect(walk, "the stopped walk was not shown at all").toBeTruthy();
    expect(walk!.className).toContain("holding");
    const text = walk!.textContent ?? "";
    expect(text).toContain("you are holding");
    expect(text).toContain("This is a position, not a failure");
    // The asset actually held, named rather than implied.
    expect(text).toContain(TOKEN_B);
  });

  it("says something different when nothing moved at all", async () => {
    await seedWalk([{ receiptState: "failed", settled: false }]);
    await render();
    const text = container!.querySelector(".route-walk")?.textContent ?? "";
    expect(text).toContain("stopped before anything moved");
    expect(text).toContain("Nothing was spent");
    expect(text).not.toContain("This is a position");
  });

  it("refuses to call an unreadable leg either done or undone", async () => {
    await seedWalk([{ receiptState: "confirmed", settled: true }, { receiptState: "unknown", settled: false }]);
    await render();
    const text = container!.querySelector(".route-walk")?.textContent ?? "";
    expect(text).toContain("cannot be read as either done or undone");
    expect(text).toContain("Nothing further will start against it");
  });

  it("shows no walk when storage holds none", async () => {
    clearWalks();
    await render();
    expect(container!.querySelector(".route-walk"), "a walk was shown with nothing saved").toBeNull();
  });
});

describe("a destination this chain cannot reach on its own", () => {
  const render = async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); });
    await settle(() => Boolean(container?.querySelector("select[aria-label='Destination on another chain']")));
  };
  const choose = async (value: string) => {
    const select = container!.querySelector("select[aria-label='Destination on another chain']") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  };

  it("says nothing at all until somewhere else is named", async () => {
    await render();
    expect(container!.querySelector(".route-plans"), "a plan was offered before one was asked for").toBeNull();
  });

  it("plans a sequence of verified legs, and prices none of it", async () => {
    await render();
    // The pair comes up with JADE paying, and the bridge leaves from JADE — a
    // one-leg plan. Reversing makes it the two-leg shape this is about.
    await press(container!.querySelector("button[aria-label='Reverse token direction']"));
    await choose(ARBITRUM_USDC);
    await settle(() => Boolean(container?.querySelector(".route-plan")));
    const text = container!.querySelector(".route-plans")?.textContent ?? "";
    expect(text).toContain("2 legs: swap → bridge");
    // The asset the holder is left holding if they stop halfway.
    expect(text).toContain(TOKEN_B);
    expect(text).toContain("eip155:31337, eip155:421614");
    // A price it cannot know must not appear as though it could.
    expect(text).toContain("Not priced here");
    expect(text).not.toContain("No verified sequence");
  });

  it("says plainly when nothing joins, rather than showing an empty box", async () => {
    await render();
    await choose("cosmos:grand-1/denom:uusdc");
    await settle(() => Boolean(container?.querySelector(".route-plan")));
    const text = container!.querySelector(".route-plans")?.textContent ?? "";
    expect(text).toContain("No verified sequence joins these two assets");
    expect(text).toContain("NO_VERIFIED_SEQUENCE_JOINS_THESE_ASSETS");
    // A dead end is worth more as a direction than as a code.
    expect(text).toContain("One more route would open it");
    // Named by its reviewed symbol, not by an identifier nobody reads.
    expect(text).toContain("USDC.n");
    expect(text).toContain("1-leg plan");
  });
});

describe("a saved swap record beside a different configuration", () => {
  // The journal keeps the most recently updated record whatever chain or pair it
  // belongs to, and the screen shows it under a heading that calls it route-bound.
  // The chain is printed inside the card, but nothing there says it is not the
  // route on screen.
  const seed = (record: unknown) => localStorage.setItem(
    "localswap:evm-swap-recovery-journal:v1",
    JSON.stringify({ schema: "localswap.evm-swap-recovery-journal.v1", records: [record] })
  );
  const render = async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); });
    await settle(() => Boolean(container?.querySelector(".swap-recovery")));
  };

  it("says so when the record belongs to another pair", async () => {
    seed(FOREIGN_RECORD);
    await render();
    expect(container!.querySelector(".swap-recovery"), "the saved record was not shown at all").toBeTruthy();
    const note = container!.querySelector(".recovery-foreign");
    // Named, so a missing note fails with what is missing rather than with a
    // complaint about comparing undefined to a string.
    expect(note, "the screen showed the record with nothing saying it is another pair").toBeTruthy();
    expect(note!.textContent).toContain("not about the pair configured here");
    expect(note!.textContent).toContain("eip155:8453");
    expect(note!.textContent).toContain("TKA");
  });

  it("refuses to be silent when the saved journal cannot be read", async () => {
    // The journal is what tells a participant whether a swap was already sent.
    // An unreadable one used to render nothing at all, which reads exactly like
    // "nothing is pending" — the one reading that invites a second send.
    localStorage.setItem("localswap:evm-swap-recovery-journal:v1", JSON.stringify({ schema: "wrong", records: [] }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); });

    expect(container!.querySelector(".swap-recovery"), "an unreadable journal must not produce a record card").toBeNull();
    const warning = container!.querySelector(".recovery-unreadable");
    expect(warning, "the screen said nothing about a journal it could not read").toBeTruthy();
    expect(warning!.textContent).toContain("読み取れませんでした");
    expect(warning!.textContent).toContain("新しい交換を始めないでください");
  });

  it("stays quiet when the journal is simply empty", async () => {
    // Nothing saved is not an error, and must not raise the same warning.
    localStorage.removeItem("localswap:evm-swap-recovery-journal:v1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); });

    expect(container!.querySelector(".recovery-unreadable")).toBeNull();
    expect(container!.querySelector(".swap-recovery")).toBeNull();
  });

  it("says nothing when the record is about the configured pair", async () => {
    seed({
      ...FOREIGN_RECORD,
      chainId: "eip155:31337",
      accountId: "eip155:31337:0x4000000000000000000000000000000000000004",
      source: { ...FOREIGN_RECORD.source, assetType: `eip155:31337/erc20:${TOKEN_A}` },
      destination: { ...FOREIGN_RECORD.destination, assetType: `eip155:31337/erc20:${TOKEN_B}` }
    });
    await render();
    await connectWallet();
    // The pair only becomes known once the pool has been read.
    await settle(() => Boolean(container?.textContent?.includes("AMBR")));
    expect(container!.querySelector(".swap-recovery"), "the saved record was not shown at all").toBeTruthy();
    expect(container!.querySelector(".recovery-foreign")).toBeNull();
  });
});

describe("the liquidity screen's withdrawal side", () => {
  // Shares are pool-specific. Showing one pool's balance while burning against
  // another reads correctly and is wrong, which is what this pins.
  const openRemove = async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); });
    await connectWallet();
    await settle(() => Boolean(container?.textContent?.includes("AMBR")));
    await press(button("Liquidity"));
    await press(button("Remove"));
    await settle(() => Boolean(container?.querySelector(".provider-tiers")));
  };
  const panel = () => (container?.textContent ?? "").replace(/\s+/g, " ");

  it("shows each tier's own balance and follows the chosen one", async () => {
    await openRemove();

    // Each row carries its own holding, not the verified pool's repeated twice.
    const rows = [...container!.querySelectorAll(".provider-tiers li")].map(item => item.textContent?.replace(/\s+/g, " ") ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("14142.0");
    expect(rows[1]).toContain("100000.0");
    expect(rows[0]).not.toContain("100000.0");

    // Both tiers hold shares, so the screen starts on the verified pool.
    expect(panel()).toMatch(/Pool ?0x667b…0bf0/);
    expect(panel()).toContain("10000.0 / 20000.0");
    expect(panel()).toContain("1 bp (0.01%)");

    const deep = [...container!.querySelectorAll(".provider-tiers li button")].find(item => item.textContent?.includes("30 bp"));
    expect(deep, "the 30 bp tier was not offered, so nothing was tested").toBeTruthy();
    await press(deep);

    expect(panel()).toMatch(/Pool ?0x9D9E…a41d/);
    expect(panel()).toContain("220000.0 / 363900.0");
    expect(panel()).toContain("30 bp (0.30%)");
  });

  it("values a burn against the book of the pool it will burn in", async () => {
    await openRemove();
    const shares = container!.querySelector('input[aria-label="LP shares to remove"]') as HTMLInputElement;
    await act(async () => { setValue(shares, "1000"); await Promise.resolve(); });

    // 1000 shares of the verified pool: 1000 * 10000 / 14142 and 1000 * 20000 / 14142.
    const onVerifiedPool = withdrawEstimate();
    expect(onVerifiedPool).toMatch(/^707\./);

    const deep = [...container!.querySelectorAll(".provider-tiers li button")].find(item => item.textContent?.includes("30 bp"));
    await press(deep);
    // Selecting a tier clears the amount, because shares are not interchangeable.
    const sharesAgain = container!.querySelector('input[aria-label="LP shares to remove"]') as HTMLInputElement;
    await act(async () => { setValue(sharesAgain, "1000"); await Promise.resolve(); });

    // The deep book pays differently for the same number of shares.
    const onDeepPool = withdrawEstimate();
    expect(onDeepPool).not.toBe(onVerifiedPool);
    expect(onDeepPool).toMatch(/^777\./);
  });
});

describe("choosing a mainnet", () => {
  it.each([["eip155:8453", "8453", "Base"], ["eip155:42161", "42161", "Arbitrum One"]])("selects %s and refuses it until the user supplies contracts", async (id, chain, name) => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); });
    await press(button("Setup"));
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Network"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, id);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect((labelled("Expected chain ID") as HTMLInputElement).value).toBe(chain);
    expect((labelled("Primary RealDEX factory") as HTMLInputElement).value).toBe("");
    expect(container.textContent).toContain("NETWORK_CONTRACTS_NOT_CONFIGURED");
    await press(button("Verify and save locally"));
    await settle(() => Boolean(container?.textContent?.includes("NETWORK_CONTRACTS_NOT_CONFIGURED:")));
    expect(container.textContent).toContain(`No Factory/Router is configured for ${name}`);
    // The user can supply their own contracts: the refusal goes away once a Factory is entered.
    await act(async () => { setValue(labelled("Primary RealDEX factory")!, FACTORY); await Promise.resolve(); });
    expect([...container.querySelectorAll(".risk-callout")].some(item => item.textContent?.includes("NETWORK_CONTRACTS_NOT_CONFIGURED"))).toBe(false);
  });
});

describe("the swap screen's own state", () => {
  it("drops the fee-tier comparison when the configuration that produced it changes", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); });
    await connectWallet();
    await settle(() => Boolean(container?.textContent?.includes("AMBR")));
    expect(container.textContent).toContain("AMBR");

    const amount = container.querySelector('input[aria-label="YOU PAY amount"]') as HTMLInputElement;
    await act(async () => { setValue(amount, "1000"); await Promise.resolve(); });
    await settle(() => Boolean(container?.textContent?.includes("Fee tiers compared")));

    expect(container.textContent).toContain("Fee tiers compared");
    expect(container.textContent).toContain("30 bp (0.30%)");

    // Change the tiers. The comparison was produced under the old configuration
    // and is rendered through the tier map that the restart empties, so leaving
    // it behind relabels every row "multi-hop" and keeps one marked selected.
    await press(button("Setup"));
    await act(async () => { setValue(labelled("料率")!, "1"); await Promise.resolve(); });
    await press(button("Swap"));

    expect(container.textContent).not.toContain("Fee tiers compared");
  });

  it("settles the deposit against the chosen tier's ratio, and says what it will not take", async () => {
    // The two books hold different ratios, so the same pair of amounts is exact
    // in one and off-ratio in the other. What the pool will take, and what is
    // therefore left unapproved, is a property of the pool being deposited into.
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); });
    await connectWallet();
    await settle(() => Boolean(container?.textContent?.includes("AMBR")));
    await press(button("Liquidity"));
    await settle(() => Boolean(container?.querySelector(".provider-tiers")));

    await act(async () => { setValue(container!.querySelector(String.raw`input[aria-label="TOKEN 0 amount"]`) as HTMLInputElement, "100"); await Promise.resolve(); });
    await act(async () => { setValue(container!.querySelector(String.raw`input[aria-label="TOKEN 1 amount"]`) as HTMLInputElement, "200"); await Promise.resolve(); });

    // 100 and 200 sit exactly on the verified pool's 1:2 book, so it takes both
    // and there is nothing to report as undeposited.
    const onVerifiedPool = liquidityPanel();
    expect(onVerifiedPool).toMatch(/Pool will take ?100\.0/);
    expect(onVerifiedPool).not.toContain("Not deposited");

    const deep = [...container!.querySelectorAll(".provider-tiers li button")].find(item => item.textContent?.includes("30 bp"));
    expect(deep, "the 30 bp tier was not offered, so nothing was tested").toBeTruthy();
    await press(deep);

    // The deep book is 220000 : 363900, so 100 of token0 can only be matched by
    // 165.40909090909090909 of token1. The rest stays in the wallet, unapproved.
    const onDeepPool = liquidityPanel();
    expect(onDeepPool).toMatch(/Pool will take ?100\.0/);
    expect(onDeepPool).toContain("165.40909090909090909");
    expect(onDeepPool).toContain("34.59090909090909091");
    expect(onDeepPool).toContain("stays in your wallet, not approved");
  });

  it("recomputes the minimum shares against the tier the deposit is aimed at", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); });
    await connectWallet();
    await settle(() => Boolean(container?.textContent?.includes("AMBR")));

    await press(button("Liquidity"));
    await settle(() => Boolean(container?.querySelector(".provider-tiers")));

    await act(async () => { setValue(container!.querySelector(String.raw`input[aria-label="TOKEN 0 amount"]`) as HTMLInputElement, "100"); await Promise.resolve(); });
    await act(async () => { setValue(container!.querySelector(String.raw`input[aria-label="TOKEN 1 amount"]`) as HTMLInputElement, "200"); await Promise.resolve(); });
    await settle(() => minimumShares() !== "");

    // 100 and 200 into the verified 1 bp book: min(100 * 14142 / 10000,
    // 200 * 14142 / 20000) = 141.42, less the 0.5% floor.
    const onVerifiedPool = minimumShares();
    expect(onVerifiedPool).toMatch(/^140\.71/);

    const deep = [...container.querySelectorAll(".provider-tiers li button")].find(item => item.textContent?.includes("30 bp"));
    expect(deep, "the 30 bp tier was not offered, so nothing was tested").toBeTruthy();
    await press(deep);

    // The deep book has traded, so its shares are worth more reserve:
    // min(100 * 282971 / 220000, 200 * 282971 / 363900) = 128.62, less the floor.
    const onDeepPool = minimumShares();
    expect(onDeepPool).not.toBe(onVerifiedPool);
    expect(onDeepPool).toMatch(/^127\.98/);
  });
});

function withdrawEstimate () {
  const text = (container?.textContent ?? "").replace(/\s+/g, " ");
  // token0 first, whatever the pair is: the fake pool names JADE as token0,
  // so a pattern written from the seeded chain's order would never match.
  return (text.match(/Estimated return ?([0-9.]+) ?[A-Z]+ ?\+ ?([0-9.]+) ?[A-Z]+/) ?? [, "", ""]).slice(1).join(" / ");
}

function liquidityPanel () {
  return (container?.textContent ?? "").replace(/\s+/g, " ");
}

function minimumShares () {
  const text = container?.textContent ?? "";
  return (text.match(/Minimum LP shares ?([0-9.]+)/) ?? [, ""])[1];
}
