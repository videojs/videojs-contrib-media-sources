export const objToTypedArr = (obj) => {
  return new Uint8Array(obj.bytes, obj.byteOffset, obj.byteLength);
};

export const typedArrToObj = (typedArr) => {
  return {
    bytes: Array.prototype.slice.call(typedArr),
    byteOffset: typedArr.byteOffset,
    byteLength: typedArr.byteLength
  };
};

export default {
  objToTypedArr,
  typedArrToObj
};
