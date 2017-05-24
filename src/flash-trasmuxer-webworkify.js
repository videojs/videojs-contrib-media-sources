import transmuxWorker from './flash-transmuxer-worker';
import work from 'webworkify';

export default () => work(transmuxWorker);
