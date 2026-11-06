#!/usr/bin/env python3
"""Independent integer/Decimal check of an E2E01 result; this is not a signature/state proof."""
import json, sys
from decimal import Decimal, localcontext
from pathlib import Path


def check(r):
    assert r['schema'] == 'realdex.owner-stack-e2e.v1' and r['status'] == 'passed'
    assert r['publicNetwork'] is False and r['productionReady'] is False
    assert r['sourceStable'] is True
    assert r['mode'] in ('api', 'browser')
    assert r['browserEndToEndPassed'] is (r['mode'] == 'browser')
    assert r['driver']['transport'] == ('direct-http' if r['mode'] == 'api' else 'chromium-dom-http')
    assert r['driver']['externalRequests'] == r['driver']['syntheticResponses'] == 0
    txs = r['transactions']
    assert [t['phase'] for t in txs] == ['deposit-base', 'sell-base', 'cancel-remainder', 'withdraw-base', 'withdraw-quote']
    assert len({t['hash'] for t in txs}) == 5
    assert r['ownerSends'] == 5 and r['counterpartySends'] == 1 and r['walletRestarts'] == 1 and r['droppedResponses'] == 1
    for t in txs:
        assert t['code'] == 0 and int(t['height']) > 0
        assert t['gasWanted'] == t['gasLimit'] and 0 < int(t['gasUsed']) <= int(t['gasLimit'])
    before, after = r['before'], r['after']
    assert int(after['sequence']) - int(before['sequence']) == 5
    assert int(before['gas']) - int(after['gas']) == sum(int(t['feeAtomic']) for t in txs)
    assert int(before['base']) - int(after['base']) == 500000000000000000
    with localcontext() as context:
        context.prec = 120
        # Fixed scenario independently supplies quantity=0.5, price=11 and quoteDecimals=6.
        notional = Decimal('0.5') * Decimal('11') * Decimal(10) ** 6
        net = notional * (1 - Decimal(r['makerFeeRate']))
        assert net == net.to_integral_value()
        assert int(after['quote']) - int(before['quote']) == int(net)
        assert int(r['quoteProceedsAtomic']) + int(r['quoteBankCreditAtomic']) == int(net)
    assert after['exchangeBase'] == after['exchangeQuote'] == '0' and after['openOrders'] == 0
    return {'schema': 'realdex.owner-stack-independent-check.v1', 'passed': True, 'mode': r['mode'],
            'commit': r['commit'], 'tree': r['tree'], 'stateProofVerified': False, 'productionReady': False}

if __name__ == '__main__':
    try:
        assert len(sys.argv) == 2
        source = Path(sys.argv[1])
        assert source.is_file() and source.stat().st_size <= 262144
        print(json.dumps(check(json.loads(source.read_text()))))
    except Exception:
        print(json.dumps({'passed': False, 'error': 'E2E_INDEPENDENT_CHECK_FAILED'}))
        raise SystemExit(1) from None
