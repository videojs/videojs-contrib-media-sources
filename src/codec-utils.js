const isAudioCodec = function(codec) {
  return (/mp4a\.\d+.\d+/i).test(codec);
};

const isVideoCodec = function(codec) {
  return (/avc1\.[\da-f]+/i).test(codec);
};

const parseContentType = function(type) {
  let object = {type: '', parameters: {}};
  let parameters = type.trim().split(';');

  // first parameter should always be content-type
  object.type = parameters.shift().trim();
  parameters.forEach((parameter) => {
    let pair = parameter.trim().split('=');

    if (pair.length > 1) {
      let name = pair[0].replace(/"/g, '').trim();
      let value = pair[1].replace(/"/g, '').trim();

      object.parameters[name] = value;
    }
  });

  return object;
};

export default {
  isAudioCodec,
  parseContentType,
  isVideoCodec
};
