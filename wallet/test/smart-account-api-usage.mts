import type {OwnerSmartPayloads,SmartOperation} from '../smart-account/api.mjs';
const payment: SmartOperation = {type:'payments',transfers:[{asset:'native',recipient:'0x1234',amount:'0.001'}]};
const p: OwnerSmartPayloads['smart/prepare'] = {id:'locally-registered-id',operation:payment};
const grant: SmartOperation = {type:'grant-session',sessionAccountId:'separate-key',asset:'native',recipient:'0x1234',perCall:'0.001',daily:'0.002',total:'0.005',validUntil:'1900000000'};
void [p,grant];
// @ts-expect-error A caller may not substitute a recipient on a session transfer.
const invalid:SmartOperation={type:'session-transfer',sessionAccountId:'key',amount:'1',recipient:'0x9876'};
// @ts-expect-error No generic UserOperation signing endpoint is exposed.
const unsupported:SmartOperation={type:'userOperation',payload:'0x'};
void [invalid,unsupported];
