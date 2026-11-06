// Development-only visual fixture, loaded solely by qaCosmosSigningReview.mjs.
import React from "react";
import { createRoot } from "react-dom/client";
import CosmosSigningReviewPanel from "../src/swap/CosmosSigningReviewPanel";
import { cosmosSigningReviewFixture } from "../src/swap/cosmos-signing-review.test-fixtures";
import "../src/styles.css";

const fixture = cosmosSigningReviewFixture();
const qaWindow = window as any;
qaWindow.__reviewFixture = fixture;
qaWindow.__reviewQa = { prepare: 0, reserve: 0, sign: 0, mode: "pending", blocked: false };
const root = createRoot(document.getElementById("qa-root")!);
const render = () => root.render(<main style={{ maxWidth: 720, margin: "16px auto", padding: "0 12px" }}>
  <p>Synthetic UI fixture — no real wallet, signing or network calls</p>
  <div className="trade-panel universe-panel"><div className="wallet-standard-discovery"><CosmosSigningReviewPanel {...fixture.props} /></div></div>
</main>);
qaWindow.__reviewRerender = render;
render();
