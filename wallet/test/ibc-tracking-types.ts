import type {IbcTrack,IbcMonitorStart,IbcMonitorStatus,IbcMonitorEntry} from '../bridge/api';
const track: IbcTrack={id:'11111111-1111-1111-1111-111111111111'};
const start: IbcMonitorStart={ids:[track.id],intervalMs:30000};
const entry: IbcMonitorEntry={id:track.id,nextAt:100,lastAt:null,checks:0,failures:0,stage:'awaiting-ack',error:null};
const state: IbcMonitorStatus={enabled:true,running:false,reason:'RUNNING',intervalMs:start.intervalMs!,readOnly:true,signingAuthority:false,relayTransactions:false,requiresUnlockedVault:true,autoResume:false,entries:[entry]};
// @ts-expect-error Monitoring never grants signing authority.
const signing: IbcMonitorStatus={...state,signingAuthority:true};
// @ts-expect-error Observations are queried by stored ID, never arbitrary RPC URL.
const injected: IbcTrack={id:track.id,rpcUrl:'https://example.invalid'};
void signing;void injected;
