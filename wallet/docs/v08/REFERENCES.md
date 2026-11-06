# Primary references checked for v0.8

Checked 2026-09-05. These sources define external formats; they do not certify this implementation.

- ERC-20: https://eips.ethereum.org/EIPS/eip-20 — optional metadata, transfer bool return, Transfer event. This release requires configured metadata and matching on-chain decimals plus a true return value; it does not accept every historical nonstandard ERC20.
- ERC-681: https://eips.ethereum.org/EIPS/eip-681 — payment URI. This release deliberately accepts only a strict subset (explicit chain ID, hex addresses, integer atomic values) and does not claim complete support.
- EIP-155: https://eips.ethereum.org/EIPS/eip-155 — replay protection by chain ID. A genesis pin in a local policy does not add a genesis field to the EVM signature; reused chain IDs can still create external replay risk.
- MCP 2025-11-25 transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports — newline JSON-RPC stdio, stdout purity. Only stdio is implemented here.
- MCP 2025-11-25 basics: https://modelcontextprotocol.io/specification/2025-11-25/basic — stdio credentials from environment rather than the HTTP OAuth flow.
- MCP 2025-11-25 tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools — tool schemas, structured results, error results, human intervention, annotations as untrusted hints.
- MCP 2025-06-18 transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports — second negotiated stdio version.

No claim is made that the custom agent HTTP API implements ERC-7715, an ERC-4337 smart account, or on-chain spending permissions. No new cryptographic library was downloaded or introduced in v0.8. The v0.7 vendored library, license and provenance are retained unchanged; this is not a new independent cryptographic audit.
