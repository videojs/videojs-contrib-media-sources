import work from 'webworkify';
import TransmuxWorker from './transmuxer-worker';
import FlashTransmuxWorker from './flash-transmuxer-worker';

export const transmuxWorker = () => work(TransmuxWorker);
export const flashTransmuxWorker = () => work(FlashTransmuxWorker);
