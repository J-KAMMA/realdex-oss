// Additional validation only. Product wallet, persistence and timeout limits are unchanged.
import '../../integration/owner-e2e/test/crash-protocol.test.mjs';
import '../../integration/owner-e2e/test/crash-host.test.mjs';
// E2E03 registers validation tests only; no production wallet or process boundary changes.
import '../../integration/owner-e2e/test/failure-protocol.test.mjs';
import '../../integration/owner-e2e/test/failure-host.test.mjs';
// E2E04: concurrent owner HTTP operations and emergency-lock boundaries, reference tests only.
import '../../integration/owner-e2e/test/concurrency-protocol.test.mjs';
import '../../integration/owner-e2e/test/concurrency-host.test.mjs';

// E2E08: additive, opt-in kernel lease candidate; default store is unchanged.
import "../../integration/owner-e2e/test/kernel-lease.test.mjs";
import "../../integration/owner-e2e/test/kernel-evidence.test.mjs";
