import work from 'webworkify';
import transmuxWorker from './transmuxer-worker';

export default () => work(transmuxWorker);
