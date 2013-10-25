function prefixedAttributeName(obj, suffix, opt_preprefix) {
  suffix = suffix.toLowerCase()
  if (opt_preprefix === undefined) {
    opt_preprefix = '';
  }
  for (var attr in obj) {
    lattr = attr.toLowerCase();
    if (lattr.indexOf(opt_preprefix) == 0 &&
        lattr.indexOf(suffix, lattr.length - suffix.length) != -1) {
      return attr;
    }
  }
  return null;
}

function normalizeAttribute(obj, suffix, opt_preprefix) {
  if (opt_preprefix === undefined) {
    opt_preprefix = '';
  }
  attr = prefixedAttributeName(obj, suffix, opt_preprefix);
  if (attr) {
    obj[opt_preprefix + suffix] = obj[attr];
  }
}

var EMEHandler = function(video) {
  this.video = video;
  normalizeAttribute(video, 'generateKeyRequest');
  normalizeAttribute(video, 'addKey');

  this.initDataQueue = [];

  this.flavor = null;
  this.keySystem = null;
  this.licenseServerURL = null;

  var attr = prefixedAttributeName(video, 'needkey', 'on');
  if (!attr) {
    // just a shot in the dark here
    video.on('needkey', this.onNeedKey.bind(this));
    video.on('keymessage', this.onKeyMessage.bind(this));
    video.on('keyerror', this.onKeyError.bind(this));
  } else {
    video.on(attr.substring(2), this.onNeedKey.bind(this));
    attr = prefixedAttributeName(video, 'keymessage', 'on');
    if (attr)
      video.on(attr.substring(2), this.onKeyMessage.bind(this));
    attr = prefixedAttributeName(video, 'keyerror', 'on');
    if (attr)
      video.on(attr.substring(2), this.onKeyError.bind(this));
  }

  normalizeAttribute(window, 'MediaKeys');

  attr = prefixedAttributeName(video, 'setMediaKeys');
  if (attr && !window.MediaKeys) {
    // try extra hard to scrounge up a MediaKeys
    var index = attr.indexOf('etMediaKeys');
    if (index != -1) {
      this.mediaKeysPrefix = attr.substring(0, index - 1).toLowerCase();
      window.MediaKeys = window[this.mediaKeysPrefix.toUpperCase() + 'MediaKeys'];
    }
  }

  normalizeAttribute(video, 'setMediaKeys');
};
window.EMEHandler = EMEHandler;

// We only use BMFF for this demo player (soon to change tho)
EMEHandler.kMime = 'video/mp4; codecs="avc1.640028"';

EMEHandler.kFlavorToSystem = {
  'clearkey': ['webkit-org.w3.clearkey', 'org.w3.clearkey'],
  'widevine': ['com.widevine.alpha'],
  'playready': ['com.youtube.playready', 'com.microsoft.playready']
};

EMEHandler.prototype.init = function(flavorMap, opt_flavor) {
  this.chooseFlavor(EMEHandler.kMime, flavorMap, opt_flavor);
  this.isClearKey = this.flavor == 'clearkey';
}

EMEHandler.prototype.chooseFlavor = function(mime, flavorMap, opt_flavor) {
  for (var flavor in flavorMap) {
    if (opt_flavor && flavor != opt_flavor) continue;
    var systems = EMEHandler.kFlavorToSystem[flavor];
    if (!systems) continue;
    for (var i in systems) {
      if (window.MediaKeys && MediaKeys.isTypeSupported) {
        if(!MediaKeys.isTypeSupported(systems[i], mime) &&
           !MediaKeys.isTypeSupported(mime, systems[i]))
        continue;
      } else if (this.video.canPlayType && !this.video.canPlayType(mime, systems[i])) {
        continue;
      }
      this.flavor = flavor;
      this.keySystem = systems[i];
      this.licenseServerURL = flavorMap[flavor];
      return;
    }
  }
  throw 'Could not find a compatible key system';
}

EMEHandler.prototype.extractBMFFClearKeyID = function(initData) {
  // Accessing the Uint8Array's underlying ArrayBuffer is impossible, so we
  // copy it to a new one for parsing.
  var abuf = new ArrayBuffer(initData.length);
  var view = new Uint8Array(abuf);
  view.set(initData);

  var dv = new DataView(abuf);
  var pos = 0;
  while (pos < abuf.byteLength) {
    var box_size = dv.getUint32(pos, false);
    var type = dv.getUint32(pos + 4, false);

    if (type != 0x70737368)
      throw 'Box type ' + type.toString(16) + ' not equal to "pssh"';

    // Scan for Clear Key header
    if ((dv.getUint32(pos + 12, false) == 0x58147ec8) &&
        (dv.getUint32(pos + 16, false) == 0x04234659) &&
        (dv.getUint32(pos + 20, false) == 0x92e6f52c) &&
        (dv.getUint32(pos + 24, false) == 0x5ce8c3cc)) {
      var size = dv.getUint32(pos + 28, false);
      if (size != 16) throw 'Unexpected KID size ' + size;
      return new Uint8Array(abuf.slice(pos + 32, pos + 32 + size));
    }

    // Failing that, scan for Widevine protobuf header
    if ((dv.getUint32(pos + 12, false) == 0xedef8ba9) &&
        (dv.getUint32(pos + 16, false) == 0x79d64ace) &&
        (dv.getUint32(pos + 20, false) == 0xa3c827dc) &&
        (dv.getUint32(pos + 24, false) == 0xd51d21ed)) {
      return new Uint8Array(abuf.slice(pos + 36, pos + 52));
    }
    pos += box_size;
  }
  // Couldn't find it, give up hope.
  return initData;
}

EMEHandler.prototype.onNeedKey = function(e) {
  dlog(2, 'onNeedKey()');
  if (!this.keySystem)
    throw 'Not initialized! Bad manifest parse?';
  if (e.initData.length == 16) {
    dlog(2, 'Dropping non-BMFF needKey event');
    return;
  }
  var initData = e.initData;
  if (this.isClearKey) {
    initData = this.extractBMFFClearKeyID(e.initData);
  }
  if (window.MediaKeys) {
    if (!this.mediaKeys) {
      this.mediaKeys = new MediaKeys(this.keySystem);
      this.video.setMediaKeys(this.mediaKeys);
    }
    var session = this.mediaKeys.createSession(EMEHandler.kMime, initData);
    session.addEventListener('keymessage', this.onKeyMessage.bind(this));
    session.addEventListener('keyerror', this.onKeyError.bind(this));
    session.addEventListener(this.mediaKeysPrefix + 'keymessage', this.onKeyMessage.bind(this));
    session.addEventListener(this.mediaKeysPrefix + 'keyerror', this.onKeyError.bind(this));
  } else {
    this.video.generateKeyRequest(this.keySystem, initData);
  }
  this.initDataQueue.push(initData);
}

EMEHandler.prototype.onKeyMessage = function(e) {
  dlog(2, 'onKeyMessage()');
  var initData = this.initDataQueue.shift();
  var xhr = new XMLHttpRequest();
  xhr.open("POST", this.licenseServerURL);
  xhr.addEventListener('load', this.onLoad.bind(this, initData, e.sessionId || e.target));
  xhr.responseType = 'arraybuffer';
  xhr.send(e.message);
}

EMEHandler.prototype.onKeyError = function(e) {
  dlog(2, 'onKeyError(' + e.keySystem + ', ' + e.errorCode.code + ', ' + e.systemCode + ')');
}

function stringToArray(s) {
  var array = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) {
    array[i] = s.charCodeAt(i);
  }
  return array;
}


function arrayToString(a) {
  return String.fromCharCode.apply(String, a);
}

EMEHandler.prototype.onLoad = function(initData, session, e) {
  dlog(2, 'onLoad(' + this.licenseServerURL + ')');
  if (e.target.status < 200 || e.target.status > 299)
    throw 'Bad XHR status: ' + e.target.statusText;

  // Parse "GLS/1.0 0 OK\r\nHeader: Value\r\n\r\n<xml>HERE BE SOAP</xml>
  var responseString = arrayToString(new Uint8Array(e.target.response)).split('\r\n').pop();
  var license = stringToArray(responseString);

  if (window.MediaKeys) {
    session.update(license);
  } else {
    this.video.addKey(this.keySystem, license, initData, session);
  }
}
