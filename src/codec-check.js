const isAudioCodec = function(codec) {
  return (/mp4a\.\d+.\d+/i).test(codec);
};

const isVideoCodec = function(codec) {
  return (/avc1\.[\da-f]+/i).test(codec);
};

export default {
  isAudioCodec,
  isVideoCodec
};
