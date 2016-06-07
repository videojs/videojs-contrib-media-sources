import videoTracks from './data/video-tracks';
import audioTracks from './data/audio-tracks';

export const createDataMessage = function({
  type,
  typedArray,
  extraObject,
  tracks
}) {
  let message = {
    data: {
      action: 'data',
      segment: {
        type,
        data: typedArray.buffer,
        tracks: tracks || (type === 'video' ? videoTracks : audioTracks)
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

