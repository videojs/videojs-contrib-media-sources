import QUnit from 'qunit';
import utils from '../src/utils';

QUnit.module('Utils');

QUnit.test('can convert between object and typed array', function() {
  let arr = [0, 1, 2, 3, 4, 5];
  let typedArr = new Uint8Array([0, 1, 2, 3, 4, 5]);
  let obj = utils.typedArrToObj(typedArr);

  QUnit.deepEqual(obj, {
    bytes: arr,
    byteOffset: 0,
    byteLength: arr.length
  }, 'can convert into object representation');
  QUnit.deepEqual(utils.objToTypedArr(obj), typedArr, 'can convert back to typed array');
});
