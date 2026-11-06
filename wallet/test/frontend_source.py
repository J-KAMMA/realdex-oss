"""Inline local modules ONLY for existing offline DOM tests, never HTTP/CSP evidence."""
def frontend_source(root):
    main=(root/'wallet/public/app.mjs').read_text()
    dependency=(root/'wallet/public/ibc.mjs').read_text()
    marker="import {createIbcPanel} from './ibc.mjs';"
    if main.count(marker)!=1:
        raise RuntimeError('OFFLINE_FRONTEND_IMPORT_GRAPH_CHANGED')
    return dependency.replace('export function createIbcPanel','function createIbcPanel',1)+'\n'+main.replace(marker,'',1)
