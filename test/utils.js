import serializedVideoTracks from './data/serialized-video-tracks.js';
import serializedAudioTracks from './data/serialized-audio-tracks.js';

export const createDataMessage = function({
  type,
  typedArray,
  extraObject,
  serializedTracks
}) {
  let message = {
    data: {
      action: 'data',
      segment: {
        type,
        data: typedArray.buffer,
        serializedTracks: serializedTracks ||
          (type === 'video' ? serializedVideoTracks : serializedAudioTracks)
      },
      byteOffset: typedArray.byteOffset,
      byteLength: typedArray.byteLength
    }
  };

  return Object.keys(extraObject || {}).reduce(function(obj, key) {
    obj.data.segment[key] = extraObject[key];
    return obj;
  }, message);
};

