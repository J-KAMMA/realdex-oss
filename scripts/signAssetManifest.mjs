import { readFile, writeFile } from "node:fs/promises";
import { Wallet, getAddress } from "ethers";

const [sourcePath, unsignedPath, outputPath] = process.argv.slice(2);
if (!sourcePath || !unsignedPath || !outputPath) fail("Usage: npm run sign:asset-manifest -- <source.json> <unsigned-manifest.json> <new-output.json>");
const privateKey = process.env.LOCALSWAP_ASSET_SOURCE_PRIVATE_KEY;
if (!privateKey) fail("LOCALSWAP_ASSET_SOURCE_PRIVATE_KEY is required and is never printed.");

const source = JSON.parse(await readFile(sourcePath, "utf8"));
const unsigned = JSON.parse(await readFile(unsignedPath, "utf8"));
if (source.schema !== "localswap.asset-source.v1" || unsigned.schema !== "localswap.signed-asset-manifest.v1") fail("Unsupported source or manifest schema.");
if (source.id !== unsigned.sourceId) fail("Manifest sourceId does not match the source descriptor.");
if ("signature" in unsigned) fail("The unsigned input must not contain a signature field.");
const wallet = new Wallet(privateKey);
if (getAddress(wallet.address) !== getAddress(source.signerAddress)) fail("The private key does not match the source descriptor signerAddress.");

const payload = canonicalPayload(unsigned);
const signature = await wallet.signMessage(payload);
await writeFile(outputPath, `${JSON.stringify({ ...unsigned, signature }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(`Signed source ${source.id} revision ${unsigned.revision} -> ${outputPath}`);

function canonicalPayload(manifest) {
  return `LocalSwap signed asset manifest v1\n${JSON.stringify({
    schema: manifest.schema,
    sourceId: manifest.sourceId,
    revision: manifest.revision,
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
    assets: manifest.assets.map((asset) => ({
      assetType: asset.assetType, symbol: asset.symbol, name: asset.name, decimals: asset.decimals,
      provenance: asset.provenance, execution: asset.execution
    })),
    evidenceUrls: manifest.evidenceUrls
  })}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
