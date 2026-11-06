import type {Selection,ObservationOptions,Snapshot} from './index.d.mts';
export function observeSpot(selection:Selection,options?:ObservationOptions):Promise<Snapshot>;
export function createObservationSession():{cancel():void;run(selection:Selection,options?:ObservationOptions):Promise<Snapshot>};
