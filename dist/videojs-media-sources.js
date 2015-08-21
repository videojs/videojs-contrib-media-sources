/*! videojs-contrib-media-sources - v1.0.0 - 2015-08-21
* Copyright (c) 2015 Brightcove; Licensed  */
/**
 * mux.js
 *
 * Copyright (c) 2014 Brightcove
 * All rights reserved.
 *
 * A lightweight readable stream implemention that handles event dispatching.
 * Objects that inherit from streams should call init in their constructors.
 */
(function(window, undefined) {
  var Stream = function() {
    this.init = function() {
      var listeners = {};
      /**
       * Add a listener for a specified event type.
       * @param type {string} the event name
       * @param listener {function} the callback to be invoked when an event of
       * the specified type occurs
       */
      this.on = function(type, listener) {
        if (!listeners[type]) {
          listeners[type] = [];
        }
        listeners[type].push(listener);
      };
      /**
       * Remove a listener for a specified event type.
       * @param type {string} the event name
       * @param listener {function} a function previously registered for this
       * type of event through `on`
       */
      this.off = function(type, listener) {
        var index;
        if (!listeners[type]) {
          return false;
        }
        index = listeners[type].indexOf(listener);
        listeners[type].splice(index, 1);
        return index > -1;
      };
      /**
       * Trigger an event of the specified type on this stream. Any additional
       * arguments to this function are passed as parameters to event listeners.
       * @param type {string} the event name
       */
      this.trigger = function(type) {
        var callbacks, i, length, args;
        callbacks = listeners[type];
        if (!callbacks) {
          return;
        }
        // Slicing the arguments on every invocation of this method
        // can add a significant amount of overhead. Avoid the
        // intermediate object creation for the common case of a
        // single callback argument
        if (arguments.length === 2) {
          length = callbacks.length;
          for (i = 0; i < length; ++i) {
            callbacks[i].call(this, arguments[1]);
          }
        } else {
          args = [];
          i = arguments.length;
          for (i = 1; i < arguments.length; ++i) {
            args.push(arguments[i])
          }
          length = callbacks.length;
          for (i = 0; i < length; ++i) {
            callbacks[i].apply(this, args);
          }
        }
      };
      /**
       * Destroys the stream and cleans up.
       */
      this.dispose = function() {
        listeners = {};
      };
    };
  };
  /**
   * Forwards all `data` events on this stream to the destination stream. The
   * destination stream should provide a method `push` to receive the data
   * events as they arrive.
   * @param destination {stream} the stream that will receive all `data` events
   * @see http://nodejs.org/api/stream.html#stream_readable_pipe_destination_options
   */
  Stream.prototype.pipe = function(destination) {
    this.on('data', function(data) {
      destination.push(data);
    });
  };

  window.muxjs = window.muxjs || {};
  window.muxjs.Stream = Stream;
})(this);

(function(window, muxjs) {

/**
 * Parser for exponential Golomb codes, a variable-bitwidth number encoding
 * scheme used by h264.
 */
muxjs.ExpGolomb = function(workingData) {
  var
    // the number of bytes left to examine in workingData
    workingBytesAvailable = workingData.byteLength,

    // the current word being examined
    workingWord = 0, // :uint

    // the number of bits left to examine in the current word
    workingBitsAvailable = 0; // :uint;

  // ():uint
  this.length = function() {
    return (8 * workingBytesAvailable);
  };

  // ():uint
  this.bitsAvailable = function() {
    return (8 * workingBytesAvailable) + workingBitsAvailable;
  };

  // ():void
  this.loadWord = function() {
    var
      position = workingData.byteLength - workingBytesAvailable,
      workingBytes = new Uint8Array(4),
      availableBytes = Math.min(4, workingBytesAvailable);

    if (availableBytes === 0) {
      throw new Error('no bytes available');
    }

    workingBytes.set(workingData.subarray(position,
                                          position + availableBytes));
    workingWord = new DataView(workingBytes.buffer).getUint32(0);

    // track the amount of workingData that has been processed
    workingBitsAvailable = availableBytes * 8;
    workingBytesAvailable -= availableBytes;
  };

  // (count:int):void
  this.skipBits = function(count) {
    var skipBytes; // :int
    if (workingBitsAvailable > count) {
      workingWord          <<= count;
      workingBitsAvailable -= count;
    } else {
      count -= workingBitsAvailable;
      skipBytes = Math.floor(count / 8);

      count -= (skipBytes * 8);
      workingBytesAvailable -= skipBytes;

      this.loadWord();

      workingWord <<= count;
      workingBitsAvailable -= count;
    }
  };

  // (size:int):uint
  this.readBits = function(size) {
    var
      bits = Math.min(workingBitsAvailable, size), // :uint
      valu = workingWord >>> (32 - bits); // :uint

    console.assert(size < 32, 'Cannot read more than 32 bits at a time');

    workingBitsAvailable -= bits;
    if (workingBitsAvailable > 0) {
      workingWord <<= bits;
    } else if (workingBytesAvailable > 0) {
      this.loadWord();
    }

    bits = size - bits;
    if (bits > 0) {
      return valu << bits | this.readBits(bits);
    } else {
      return valu;
    }
  };

  // ():uint
  this.skipLeadingZeros = function() {
    var leadingZeroCount; // :uint
    for (leadingZeroCount = 0 ; leadingZeroCount < workingBitsAvailable ; ++leadingZeroCount) {
      if (0 !== (workingWord & (0x80000000 >>> leadingZeroCount))) {
        // the first bit of working word is 1
        workingWord <<= leadingZeroCount;
        workingBitsAvailable -= leadingZeroCount;
        return leadingZeroCount;
      }
    }

    // we exhausted workingWord and still have not found a 1
    this.loadWord();
    return leadingZeroCount + this.skipLeadingZeros();
  };

  // ():void
  this.skipUnsignedExpGolomb = function() {
    this.skipBits(1 + this.skipLeadingZeros());
  };

  // ():void
  this.skipExpGolomb = function() {
    this.skipBits(1 + this.skipLeadingZeros());
  };

  // ():uint
  this.readUnsignedExpGolomb = function() {
    var clz = this.skipLeadingZeros(); // :uint
    return this.readBits(clz + 1) - 1;
  };

  // ():int
  this.readExpGolomb = function() {
    var valu = this.readUnsignedExpGolomb(); // :int
    if (0x01 & valu) {
      // the number is odd if the low order bit is set
      return (1 + valu) >>> 1; // add 1 to make it even, and divide by 2
    } else {
      return -1 * (valu >>> 1); // divide by two then make it negative
    }
  };

  // Some convenience functions
  // :Boolean
  this.readBoolean = function() {
    return 1 === this.readBits(1);
  };

  // ():int
  this.readUnsignedByte = function() {
    return this.readBits(8);
  };

  this.loadWord();

};
})(this, this.muxjs);

/**
 * An object that stores the bytes of an FLV tag and methods for
 * querying and manipulating that data.
 * @see http://download.macromedia.com/f4v/video_file_format_spec_v10_1.pdf
 */
(function(window) {

window.videojs = window.videojs || {};
window.muxjs = window.muxjs || {};

var hls = window.muxjs;

// (type:uint, extraData:Boolean = false) extends ByteArray
hls.FlvTag = function(type, extraData) {
  var
    // Counter if this is a metadata tag, nal start marker if this is a video
    // tag. unused if this is an audio tag
    adHoc = 0, // :uint

    // checks whether the FLV tag has enough capacity to accept the proposed
    // write and re-allocates the internal buffers if necessary
    prepareWrite = function(flv, count) {
      var
        bytes,
        minLength = flv.position + count;
      if (minLength < flv.bytes.byteLength) {
        // there's enough capacity so do nothing
        return;
      }

      // allocate a new buffer and copy over the data that will not be modified
      bytes = new Uint8Array(minLength * 2);
      bytes.set(flv.bytes.subarray(0, flv.position), 0);
      flv.bytes = bytes;
      flv.view = new DataView(flv.bytes.buffer);
    },

    // commonly used metadata properties
    widthBytes = hls.FlvTag.widthBytes || new Uint8Array('width'.length),
    heightBytes = hls.FlvTag.heightBytes || new Uint8Array('height'.length),
    videocodecidBytes = hls.FlvTag.videocodecidBytes || new Uint8Array('videocodecid'.length),
    i;

  if (!hls.FlvTag.widthBytes) {
    // calculating the bytes of common metadata names ahead of time makes the
    // corresponding writes faster because we don't have to loop over the
    // characters
    // re-test with test/perf.html if you're planning on changing this
    for (i = 0; i < 'width'.length; i++) {
      widthBytes[i] = 'width'.charCodeAt(i);
    }
    for (i = 0; i < 'height'.length; i++) {
      heightBytes[i] = 'height'.charCodeAt(i);
    }
    for (i = 0; i < 'videocodecid'.length; i++) {
      videocodecidBytes[i] = 'videocodecid'.charCodeAt(i);
    }

    hls.FlvTag.widthBytes = widthBytes;
    hls.FlvTag.heightBytes = heightBytes;
    hls.FlvTag.videocodecidBytes = videocodecidBytes;
  }

  this.keyFrame = false; // :Boolean

  switch(type) {
  case hls.FlvTag.VIDEO_TAG:
    this.length = 16;
    break;
  case hls.FlvTag.AUDIO_TAG:
    this.length = 13;
    this.keyFrame = true;
    break;
  case hls.FlvTag.METADATA_TAG:
    this.length = 29;
    this.keyFrame = true;
    break;
  default:
    throw("Error Unknown TagType");
  }

  this.bytes = new Uint8Array(16384);
  this.view = new DataView(this.bytes.buffer);
  this.bytes[0] = type;
  this.position = this.length;
  this.keyFrame = extraData; // Defaults to false

  // presentation timestamp
  this.pts = 0;
  // decoder timestamp
  this.dts = 0;

  // ByteArray#writeBytes(bytes:ByteArray, offset:uint = 0, length:uint = 0)
  this.writeBytes = function(bytes, offset, length) {
    var
      start = offset || 0,
      end;
    length = length || bytes.byteLength;
    end = start + length;

    prepareWrite(this, length);
    this.bytes.set(bytes.subarray(start, end), this.position);

    this.position += length;
    this.length = Math.max(this.length, this.position);
  };

  // ByteArray#writeByte(value:int):void
  this.writeByte = function(byte) {
    prepareWrite(this, 1);
    this.bytes[this.position] = byte;
    this.position++;
    this.length = Math.max(this.length, this.position);
  };

  // ByteArray#writeShort(value:int):void
  this.writeShort = function(short) {
    prepareWrite(this, 2);
    this.view.setUint16(this.position, short);
    this.position += 2;
    this.length = Math.max(this.length, this.position);
  };

  // Negative index into array
  // (pos:uint):int
  this.negIndex = function(pos) {
    return this.bytes[this.length - pos];
  };

  // The functions below ONLY work when this[0] == VIDEO_TAG.
  // We are not going to check for that because we dont want the overhead
  // (nal:ByteArray = null):int
  this.nalUnitSize = function() {
    if (adHoc === 0) {
      return 0;
    }

    return this.length - (adHoc + 4);
  };

  this.startNalUnit = function() {
    // remember position and add 4 bytes
    if (adHoc > 0) {
      throw new Error("Attempted to create new NAL wihout closing the old one");
    }

    // reserve 4 bytes for nal unit size
    adHoc = this.length;
    this.length += 4;
    this.position = this.length;
  };

  // (nal:ByteArray = null):void
  this.endNalUnit = function(nalContainer) {
    var
      nalStart, // :uint
      nalLength; // :uint

    // Rewind to the marker and write the size
    if (this.length === adHoc + 4) {
      // we started a nal unit, but didnt write one, so roll back the 4 byte size value
      this.length -= 4;
    } else if (adHoc > 0) {
      nalStart = adHoc + 4;
      nalLength = this.length - nalStart;

      this.position = adHoc;
      this.view.setUint32(this.position, nalLength);
      this.position = this.length;

      if (nalContainer) {
        // Add the tag to the NAL unit
        nalContainer.push(this.bytes.subarray(nalStart, nalStart + nalLength));
      }
    }

    adHoc = 0;
  };

  /**
   * Write out a 64-bit floating point valued metadata property. This method is
   * called frequently during a typical parse and needs to be fast.
   */
  // (key:String, val:Number):void
  this.writeMetaDataDouble = function(key, val) {
    var i;
    prepareWrite(this, 2 + key.length + 9);

    // write size of property name
    this.view.setUint16(this.position, key.length);
    this.position += 2;

    // this next part looks terrible but it improves parser throughput by
    // 10kB/s in my testing

    // write property name
    if (key === 'width') {
      this.bytes.set(widthBytes, this.position);
      this.position += 5;
    } else if (key === 'height') {
      this.bytes.set(heightBytes, this.position);
      this.position += 6;
    } else if (key === 'videocodecid') {
      this.bytes.set(videocodecidBytes, this.position);
      this.position += 12;
    } else {
      for (i = 0; i < key.length; i++) {
        this.bytes[this.position] = key.charCodeAt(i);
        this.position++;
      }
    }

    // skip null byte
    this.position++;

    // write property value
    this.view.setFloat64(this.position, val);
    this.position += 8;

    // update flv tag length
    this.length = Math.max(this.length, this.position);
    ++adHoc;
  };

  // (key:String, val:Boolean):void
  this.writeMetaDataBoolean = function(key, val) {
    var i;
    prepareWrite(this, 2);
    this.view.setUint16(this.position, key.length);
    this.position += 2;
    for (i = 0; i < key.length; i++) {
      console.assert(key.charCodeAt(i) < 255);
      prepareWrite(this, 1);
      this.bytes[this.position] = key.charCodeAt(i);
      this.position++;
    }
    prepareWrite(this, 2);
    this.view.setUint8(this.position, 0x01);
    this.position++;
    this.view.setUint8(this.position, val ? 0x01 : 0x00);
    this.position++;
    this.length = Math.max(this.length, this.position);
    ++adHoc;
  };

  // ():ByteArray
  this.finalize = function() {
    var
      dtsDelta, // :int
      len; // :int

    switch(this.bytes[0]) {
      // Video Data
    case hls.FlvTag.VIDEO_TAG:
      this.bytes[11] = ((this.keyFrame || extraData) ? 0x10 : 0x20 ) | 0x07; // We only support AVC, 1 = key frame (for AVC, a seekable frame), 2 = inter frame (for AVC, a non-seekable frame)
      this.bytes[12] = extraData ?  0x00 : 0x01;

      dtsDelta = this.pts - this.dts;
      this.bytes[13] = (dtsDelta & 0x00FF0000) >>> 16;
      this.bytes[14] = (dtsDelta & 0x0000FF00) >>>  8;
      this.bytes[15] = (dtsDelta & 0x000000FF) >>>  0;
      break;

    case hls.FlvTag.AUDIO_TAG:
      this.bytes[11] = 0xAF; // 44 kHz, 16-bit stereo
      this.bytes[12] = extraData ? 0x00 : 0x01;
      break;

    case hls.FlvTag.METADATA_TAG:
      this.position = 11;
      this.view.setUint8(this.position, 0x02); // String type
      this.position++;
      this.view.setUint16(this.position, 0x0A); // 10 Bytes
      this.position += 2;
      // set "onMetaData"
      this.bytes.set([0x6f, 0x6e, 0x4d, 0x65,
                      0x74, 0x61, 0x44, 0x61,
                      0x74, 0x61], this.position);
      this.position += 10;
      this.bytes[this.position] = 0x08; // Array type
      this.position++;
      this.view.setUint32(this.position, adHoc);
      this.position = this.length;
      this.bytes.set([0, 0, 9], this.position);
      this.position += 3; // End Data Tag
      this.length = this.position;
      break;
    }

    len = this.length - 11;

    // write the DataSize field
    this.bytes[ 1] = (len & 0x00FF0000) >>> 16;
    this.bytes[ 2] = (len & 0x0000FF00) >>>  8;
    this.bytes[ 3] = (len & 0x000000FF) >>>  0;
    // write the Timestamp
    this.bytes[ 4] = (this.dts & 0x00FF0000) >>> 16;
    this.bytes[ 5] = (this.dts & 0x0000FF00) >>>  8;
    this.bytes[ 6] = (this.dts & 0x000000FF) >>>  0;
    this.bytes[ 7] = (this.dts & 0xFF000000) >>> 24;
    // write the StreamID
    this.bytes[ 8] = 0;
    this.bytes[ 9] = 0;
    this.bytes[10] = 0;

    // Sometimes we're at the end of the view and have one slot to write a
    // uint32, so, prepareWrite of count 4, since, view is uint8
    prepareWrite(this, 4);
    this.view.setUint32(this.length, this.length);
    this.length += 4;
    this.position += 4;

    // trim down the byte buffer to what is actually being used
    this.bytes = this.bytes.subarray(0, this.length);
    this.frameTime = hls.FlvTag.frameTime(this.bytes);
    console.assert(this.bytes.byteLength === this.length);
    return this;
  };
};

hls.FlvTag.AUDIO_TAG = 0x08; // == 8, :uint
hls.FlvTag.VIDEO_TAG = 0x09; // == 9, :uint
hls.FlvTag.METADATA_TAG = 0x12; // == 18, :uint

// (tag:ByteArray):Boolean {
hls.FlvTag.isAudioFrame = function(tag) {
  return hls.FlvTag.AUDIO_TAG === tag[0];
};

// (tag:ByteArray):Boolean {
hls.FlvTag.isVideoFrame = function(tag) {
  return hls.FlvTag.VIDEO_TAG === tag[0];
};

// (tag:ByteArray):Boolean {
hls.FlvTag.isMetaData = function(tag) {
  return hls.FlvTag.METADATA_TAG === tag[0];
};

// (tag:ByteArray):Boolean {
hls.FlvTag.isKeyFrame = function(tag) {
  if (hls.FlvTag.isVideoFrame(tag)) {
    return tag[11] === 0x17;
  }

  if (hls.FlvTag.isAudioFrame(tag)) {
    return true;
  }

  if (hls.FlvTag.isMetaData(tag)) {
    return true;
  }

  return false;
};

// (tag:ByteArray):uint {
hls.FlvTag.frameTime = function(tag) {
  var pts = tag[ 4] << 16; // :uint
  pts |= tag[ 5] <<  8;
  pts |= tag[ 6] <<  0;
  pts |= tag[ 7] << 24;
  return pts;
};

})(this);

(function(window) {
var
  FlvTag = window.muxjs.FlvTag,
  adtsSampleingRates = [
    96000, 88200,
    64000, 48000,
    44100, 32000,
    24000, 22050,
    16000, 12000
  ];

window.muxjs.AacStream = function() {
  var
    next_pts, // :uint
    state, // :uint
    pes_length, // :int
    lastMetaPts,

    adtsProtectionAbsent, // :Boolean
    adtsObjectType, // :int
    adtsSampleingIndex, // :int
    adtsChanelConfig, // :int
    adtsFrameSize, // :int
    adtsSampleCount, // :int
    adtsDuration, // :int

    aacFrame, // :FlvTag = null;
    extraData; // :uint;

  this.tags = [];

  // (pts:uint):void
  this.setTimeStampOffset = function(pts) {

    // keep track of the last time a metadata tag was written out
    // set the initial value so metadata will be generated before any
    // payload data
    lastMetaPts = pts - 1000;
  };

  // (pts:uint, pes_size:int, dataAligned:Boolean):void
  this.setNextTimeStamp = function(pts, pes_size, dataAligned) {
    next_pts = pts;
    pes_length = pes_size;

    // If data is aligned, flush all internal buffers
    if (dataAligned) {
      state = 0;
    }
  };

  // (data:ByteArray, o:int = 0, l:int = 0):void
  this.writeBytes = function(data, offset, length) {
    var
      end, // :int
      newExtraData, // :uint
      bytesToCopy; // :int

    // default arguments
    offset = offset || 0;
    length = length || 0;

    // Do not allow more than 'pes_length' bytes to be written
    length = (pes_length < length ? pes_length : length);
    pes_length -= length;
    end = offset + length;
    while (offset < end) {
      switch (state) {
      default:
        state = 0;
        break;
      case 0:
        if (offset >= end) {
          return;
        }
        if (0xFF !== data[offset]) {
          console.assert(false, 'Error no ATDS header found');
          offset += 1;
          state = 0;
          return;
        }

        offset += 1;
        state = 1;
        break;
      case 1:
        if (offset >= end) {
          return;
        }
        if (0xF0 !== (data[offset] & 0xF0)) {
          console.assert(false, 'Error no ATDS header found');
          offset +=1;
          state = 0;
          return;
        }

        adtsProtectionAbsent = !!(data[offset] & 0x01);

        offset += 1;
        state = 2;
        break;
      case 2:
        if (offset >= end) {
          return;
        }
        adtsObjectType = ((data[offset] & 0xC0) >>> 6) + 1;
        adtsSampleingIndex = ((data[offset] & 0x3C) >>> 2);
        adtsChanelConfig = ((data[offset] & 0x01) << 2);

        offset += 1;
        state = 3;
        break;
      case 3:
        if (offset >= end) {
          return;
        }
        adtsChanelConfig |= ((data[offset] & 0xC0) >>> 6);
        adtsFrameSize = ((data[offset] & 0x03) << 11);

        offset += 1;
        state = 4;
        break;
      case 4:
        if (offset >= end) {
          return;
        }
        adtsFrameSize |= (data[offset] << 3);

        offset += 1;
        state = 5;
        break;
      case 5:
        if(offset >= end) {
          return;
        }
        adtsFrameSize |= ((data[offset] & 0xE0) >>> 5);
        adtsFrameSize -= (adtsProtectionAbsent ? 7 : 9);

        offset += 1;
        state = 6;
        break;
      case 6:
        if (offset >= end) {
          return;
        }
        adtsSampleCount = ((data[offset] & 0x03) + 1) * 1024;
        adtsDuration = (adtsSampleCount * 1000) / adtsSampleingRates[adtsSampleingIndex];

        newExtraData = (adtsObjectType << 11) |
                       (adtsSampleingIndex << 7) |
                       (adtsChanelConfig << 3);

        // write out metadata tags every 1 second so that the decoder
        // is re-initialized quickly after seeking into a different
        // audio configuration
        if (newExtraData !== extraData || next_pts - lastMetaPts >= 1000) {
          aacFrame = new FlvTag(FlvTag.METADATA_TAG);
          aacFrame.pts = next_pts;
          aacFrame.dts = next_pts;

          // AAC is always 10
          aacFrame.writeMetaDataDouble("audiocodecid", 10);
          aacFrame.writeMetaDataBoolean("stereo", 2 === adtsChanelConfig);
          aacFrame.writeMetaDataDouble ("audiosamplerate", adtsSampleingRates[adtsSampleingIndex]);
          // Is AAC always 16 bit?
          aacFrame.writeMetaDataDouble ("audiosamplesize", 16);

          this.tags.push(aacFrame);

          extraData = newExtraData;
          aacFrame = new FlvTag(FlvTag.AUDIO_TAG, true);
          // For audio, DTS is always the same as PTS. We want to set the DTS
          // however so we can compare with video DTS to determine approximate
          // packet order
          aacFrame.pts = next_pts;
          aacFrame.dts = aacFrame.pts;

          aacFrame.view.setUint16(aacFrame.position, newExtraData);
          aacFrame.position += 2;
          aacFrame.length = Math.max(aacFrame.length, aacFrame.position);

          this.tags.push(aacFrame);

          lastMetaPts = next_pts;
        }

        // Skip the checksum if there is one
        offset += 1;
        state = 7;
        break;
      case 7:
        if (!adtsProtectionAbsent) {
          if (2 > (end - offset)) {
            return;
          } else {
            offset += 2;
          }
        }

        aacFrame = new FlvTag(FlvTag.AUDIO_TAG);
        aacFrame.pts = next_pts;
        aacFrame.dts = next_pts;
        state = 8;
        break;
      case 8:
        while (adtsFrameSize) {
          if (offset >= end) {
            return;
          }
          bytesToCopy = (end - offset) < adtsFrameSize ? (end - offset) : adtsFrameSize;
          aacFrame.writeBytes(data, offset, bytesToCopy);
          offset += bytesToCopy;
          adtsFrameSize -= bytesToCopy;
        }

        this.tags.push(aacFrame);

        // finished with this frame
        state = 0;
        next_pts += adtsDuration;
      }
    }
  };
};

})(this);

(function(window) {
  var
    FlvTag = window.muxjs.FlvTag,
    H264ExtraData = window.muxjs.H264ExtraData,
    H264Stream,
    NALUnitType;

  /**
   * Network Abstraction Layer (NAL) units are the packets of an H264
   * stream. NAL units are divided into types based on their payload
   * data. Each type has a unique numeric identifier.
   *
   *              NAL unit
   * |- NAL header -|------ RBSP ------|
   *
   * NAL unit: Network abstraction layer unit. The combination of a NAL
   * header and an RBSP.
   * NAL header: the encapsulation unit for transport-specific metadata in
   * an h264 stream. Exactly one byte.
   */
  // incomplete, see Table 7.1 of ITU-T H.264 for 12-32
  window.muxjs.NALUnitType = NALUnitType = {
    unspecified: 0,
    slice_layer_without_partitioning_rbsp_non_idr: 1,
    slice_data_partition_a_layer_rbsp: 2,
    slice_data_partition_b_layer_rbsp: 3,
    slice_data_partition_c_layer_rbsp: 4,
    slice_layer_without_partitioning_rbsp_idr: 5,
    sei_rbsp: 6,
    seq_parameter_set_rbsp: 7,
    pic_parameter_set_rbsp: 8,
    access_unit_delimiter_rbsp: 9,
    end_of_seq_rbsp: 10,
    end_of_stream_rbsp: 11
  };

  window.muxjs.H264Stream = H264Stream = function() {
    this._next_pts = 0; // :uint;
    this._next_dts = 0; // :uint;

    this._h264Frame = null; // :FlvTag

    this._oldExtraData = new H264ExtraData(); // :H264ExtraData
    this._newExtraData = new H264ExtraData(); // :H264ExtraData

    this._nalUnitType = -1; // :int

    this._state = 0; // :uint;

    this.tags = [];
  };

  //(pts:uint):void
  H264Stream.prototype.setTimeStampOffset = function() {};

  //(pts:uint, dts:uint, dataAligned:Boolean):void
  H264Stream.prototype.setNextTimeStamp = function(pts, dts, dataAligned) {
    // We could end up with a DTS less than 0 here. We need to deal with that!
    this._next_pts = pts;
    this._next_dts = dts;

    // If data is aligned, flush all internal buffers
    if (dataAligned) {
      this.finishFrame();
    }
  };

  H264Stream.prototype.finishFrame = function() {
    if (this._h264Frame) {
      // Push SPS before EVERY IDR frame for seeking
      if (this._newExtraData.extraDataExists()) {
        this._oldExtraData = this._newExtraData;
        this._newExtraData = new H264ExtraData();
      }

      // Check if keyframe and the length of tags.
      // This makes sure we write metadata on the first frame of a segment.
      if (this._oldExtraData.extraDataExists() &&
          (this._h264Frame.keyFrame || this.tags.length === 0)) {
        // Push extra data on every IDR frame in case we did a stream change + seek
        this.tags.push(this._oldExtraData.metaDataTag(this._h264Frame.pts));
        this.tags.push(this._oldExtraData.extraDataTag(this._h264Frame.pts));
      }

      this._h264Frame.endNalUnit();
      this.tags.push(this._h264Frame);

    }

    this._h264Frame = null;
    this._nalUnitType = -1;
    this._state = 0;
  };

  // (data:ByteArray, o:int, l:int):void
  H264Stream.prototype.writeBytes = function(data, offset, length) {
    var
      nalUnitSize, // :uint
      start, // :uint
      end, // :uint
      t; // :int

    // default argument values
    offset = offset || 0;
    length = length || 0;

    if (length <= 0) {
      // data is empty so there's nothing to write
      return;
    }

    // scan through the bytes until we find the start code (0x000001) for a
    // NAL unit and then begin writing it out
    // strip NAL start codes as we go
    switch (this._state) {
    default:
      /* falls through */
    case 0:
      this._state = 1;
      /* falls through */
    case 1:
      // A NAL unit may be split across two TS packets. Look back a bit to
      // make sure the prefix of the start code wasn't already written out.
      if (data[offset] <= 1) {
        nalUnitSize = this._h264Frame ? this._h264Frame.nalUnitSize() : 0;
        if (nalUnitSize >= 1 && this._h264Frame.negIndex(1) === 0) {
          // ?? ?? 00 | O[01] ?? ??
          if (data[offset] === 1 &&
              nalUnitSize >= 2 &&
              this._h264Frame.negIndex(2) === 0) {
            // ?? 00 00 : 01
            if (3 <= nalUnitSize && 0 === this._h264Frame.negIndex(3)) {
              this._h264Frame.length -= 3; // 00 00 00 : 01
            } else {
              this._h264Frame.length -= 2; // 00 00 : 01
            }

            this._state = 3;
            return this.writeBytes(data, offset + 1, length - 1);
          }

          if (length > 1 && data[offset] === 0 && data[offset + 1] === 1) {
            // ?? 00 | 00 01
            if (nalUnitSize >= 2 && this._h264Frame.negIndex(2) === 0) {
              this._h264Frame.length -= 2; // 00 00 : 00 01
            } else {
              this._h264Frame.length -= 1; // 00 : 00 01
            }

            this._state = 3;
            return this.writeBytes(data, offset + 2, length - 2);
          }

          if (length > 2 &&
              data[offset] === 0 &&
              data[offset + 1] === 0 &&
              data[offset + 2] === 1) {
            // 00 : 00 00 01
            // this._h264Frame.length -= 1;
            this._state = 3;
            return this.writeBytes(data, offset + 3, length - 3);
          }
        }
      }
      // allow fall through if the above fails, we may end up checking a few
      // bytes a second time. But that case will be VERY rare
      this._state = 2;
      /* falls through */
    case 2:
      // Look for start codes in the data from the current offset forward
      start = offset;
      end = start + length;
      for (t = end - 3; offset < t;) {
        if (data[offset + 2] > 1) {
          // if data[offset + 2] is greater than 1, there is no way a start
          // code can begin before offset + 3
          offset += 3;
        } else if (data[offset + 1] !== 0) {
            offset += 2;
        } else if (data[offset] !== 0) {
            offset += 1;
        } else {
          // If we get here we have 00 00 00 or 00 00 01
          if (data[offset + 2] === 1) {
            if (offset > start) {
              this._h264Frame.writeBytes(data, start, offset - start);
            }
            this._state = 3;
            offset += 3;
            return this.writeBytes(data, offset, end - offset);
          }

          if (end - offset >= 4 &&
              data[offset + 2] === 0 &&
              data[offset + 3] === 1) {
            if (offset > start) {
              this._h264Frame.writeBytes(data, start, offset - start);
            }
            this._state = 3;
            offset += 4;
            return this.writeBytes(data, offset, end - offset);
          }

          // We are at the end of the buffer, or we have 3 NULLS followed by
          // something that is not a 1, either way we can step forward by at
          // least 3
          offset += 3;
        }
      }

      // We did not find any start codes. Try again next packet
      this._state = 1;
      if (this._h264Frame) {
        this._h264Frame.writeBytes(data, start, length);
      }
      return;
    case 3:
      // The next byte is the first byte of a NAL Unit

      if (this._h264Frame) {
        // we've come to a new NAL unit so finish up the one we've been
        // working on

        switch (this._nalUnitType) {
        case NALUnitType.seq_parameter_set_rbsp:
          this._h264Frame.endNalUnit(this._newExtraData.sps);
          break;
        case NALUnitType.pic_parameter_set_rbsp:
          this._h264Frame.endNalUnit(this._newExtraData.pps);
          break;
        case NALUnitType.slice_layer_without_partitioning_rbsp_idr:
          this._h264Frame.endNalUnit();
          break;
        default:
          this._h264Frame.endNalUnit();
          break;
        }
      }

      // setup to begin processing the new NAL unit
      this._nalUnitType = data[offset] & 0x1F;
      if (this._h264Frame) {
          if (this._nalUnitType === NALUnitType.access_unit_delimiter_rbsp) {
            // starting a new access unit, flush the previous one
            this.finishFrame();
          } else if (this._nalUnitType === NALUnitType.slice_layer_without_partitioning_rbsp_idr) {
            this._h264Frame.keyFrame = true;
          }
      }

      // finishFrame may render this._h264Frame null, so we must test again
      if (!this._h264Frame) {
        this._h264Frame = new FlvTag(FlvTag.VIDEO_TAG);
        this._h264Frame.pts = this._next_pts;
        this._h264Frame.dts = this._next_dts;
      }

      this._h264Frame.startNalUnit();
      // We know there will not be an overlapping start code, so we can skip
      // that test
      this._state = 2;
      return this.writeBytes(data, offset, length);
    } // switch
  };
})(this);

/**
 * Accepts program elementary stream (PES) data events and parses out
 * ID3 metadata from them, if present.
 * @see http://id3.org/id3v2.3.0
 */
(function(window, muxjs, undefined) {
  'use strict';
  var
    // return a percent-encoded representation of the specified byte range
    // @see http://en.wikipedia.org/wiki/Percent-encoding
    percentEncode = function(bytes, start, end) {
      var i, result = '';
      for (i = start; i < end; i++) {
        result += '%' + ('00' + bytes[i].toString(16)).slice(-2);
      }
      return result;
    },
    // return the string representation of the specified byte range,
    // interpreted as UTf-8.
    parseUtf8 = function(bytes, start, end) {
      return window.decodeURIComponent(percentEncode(bytes, start, end));
    },
    // return the string representation of the specified byte range,
    // interpreted as ISO-8859-1.
    parseIso88591 = function(bytes, start, end) {
      return window.unescape(percentEncode(bytes, start, end));
    },
    tagParsers = {
      'TXXX': function(tag) {
        var i;
        if (tag.data[0] !== 3) {
          // ignore frames with unrecognized character encodings
          return;
        }

        for (i = 1; i < tag.data.length; i++) {
          if (tag.data[i] === 0) {
            // parse the text fields
            tag.description = parseUtf8(tag.data, 1, i);
            // do not include the null terminator in the tag value
            tag.value = parseUtf8(tag.data, i + 1, tag.data.length - 1);
            break;
          }
        }
      },
      'WXXX': function(tag) {
        var i;
        if (tag.data[0] !== 3) {
          // ignore frames with unrecognized character encodings
          return;
        }

        for (i = 1; i < tag.data.length; i++) {
          if (tag.data[i] === 0) {
            // parse the description and URL fields
            tag.description = parseUtf8(tag.data, 1, i);
            tag.url = parseUtf8(tag.data, i + 1, tag.data.length);
            break;
          }
        }
      },
      'PRIV': function(tag) {
        var i;

        for (i = 0; i < tag.data.length; i++) {
          if (tag.data[i] === 0) {
            // parse the description and URL fields
            tag.owner = parseIso88591(tag.data, 0, i);
            break;
          }
        }
        tag.privateData = tag.data.subarray(i + 1);
      }
    },
    MetadataStream;

  MetadataStream = function(options) {
    var
      settings = {
        debug: !!(options && options.debug),

        // the bytes of the program-level descriptor field in MP2T
        // see ISO/IEC 13818-1:2013 (E), section 2.6 "Program and
        // program element descriptors"
        descriptor: options && options.descriptor
      },
      // the total size in bytes of the ID3 tag being parsed
      tagSize = 0,
      // tag data that is not complete enough to be parsed
      buffer = [],
      // the total number of bytes currently in the buffer
      bufferSize = 0,
      i;

    MetadataStream.prototype.init.call(this);

    // calculate the text track in-band metadata track dispatch type
    // https://html.spec.whatwg.org/multipage/embedded-content.html#steps-to-expose-a-media-resource-specific-text-track
    this.dispatchType = muxjs.SegmentParser.STREAM_TYPES.metadata.toString(16);
    if (settings.descriptor) {
      for (i = 0; i < settings.descriptor.length; i++) {
        this.dispatchType += ('00' + settings.descriptor[i].toString(16)).slice(-2);
      }
    }

    this.push = function(chunk) {
      var tag, frameStart, frameSize, frame, i;

      // ignore events that don't look like ID3 data
      if (buffer.length === 0 &&
          (chunk.data.length < 10 ||
           chunk.data[0] !== 'I'.charCodeAt(0) ||
           chunk.data[1] !== 'D'.charCodeAt(0) ||
           chunk.data[2] !== '3'.charCodeAt(0))) {
        if (settings.debug) {
          console.log('Skipping unrecognized metadata packet');
        }
        return;
      }

      // add this chunk to the data we've collected so far
      buffer.push(chunk);
      bufferSize += chunk.data.byteLength;

      // grab the size of the entire frame from the ID3 header
      if (buffer.length === 1) {
        // the frame size is transmitted as a 28-bit integer in the
        // last four bytes of the ID3 header.
        // The most significant bit of each byte is dropped and the
        // results concatenated to recover the actual value.
        tagSize = (chunk.data[6] << 21) |
                  (chunk.data[7] << 14) |
                  (chunk.data[8] << 7) |
                  (chunk.data[9]);

        // ID3 reports the tag size excluding the header but it's more
        // convenient for our comparisons to include it
        tagSize += 10;
      }

      // if the entire frame has not arrived, wait for more data
      if (bufferSize < tagSize) {
        return;
      }

      // collect the entire frame so it can be parsed
      tag = {
        data: new Uint8Array(tagSize),
        frames: [],
        pts: buffer[0].pts,
        dts: buffer[0].dts
      };
      for (i = 0; i < tagSize;) {
        tag.data.set(buffer[0].data, i);
        i += buffer[0].data.byteLength;
        bufferSize -= buffer[0].data.byteLength;
        buffer.shift();
      }

      // find the start of the first frame and the end of the tag
      frameStart = 10;
      if (tag.data[5] & 0x40) {
        // advance the frame start past the extended header
        frameStart += 4; // header size field
        frameStart += (tag.data[10] << 24) |
                      (tag.data[11] << 16) |
                      (tag.data[12] << 8)  |
                      (tag.data[13]);

        // clip any padding off the end
        tagSize -= (tag.data[16] << 24) |
                   (tag.data[17] << 16) |
                   (tag.data[18] << 8)  |
                   (tag.data[19]);
      }

      // parse one or more ID3 frames
      // http://id3.org/id3v2.3.0#ID3v2_frame_overview
      do {
        // determine the number of bytes in this frame
        frameSize = (tag.data[frameStart + 4] << 24) |
                    (tag.data[frameStart + 5] << 16) |
                    (tag.data[frameStart + 6] <<  8) |
                    (tag.data[frameStart + 7]);
        if (frameSize < 1) {
          return console.log('Malformed ID3 frame encountered. Skipping metadata parsing.');
        }

        frame = {
          id: String.fromCharCode(tag.data[frameStart],
                                  tag.data[frameStart + 1],
                                  tag.data[frameStart + 2],
                                  tag.data[frameStart + 3]),
          data: tag.data.subarray(frameStart + 10, frameStart + frameSize + 10)
        };
        if (tagParsers[frame.id]) {
          tagParsers[frame.id](frame);
        }
        tag.frames.push(frame);

        frameStart += 10; // advance past the frame header
        frameStart += frameSize; // advance past the frame body
      } while (frameStart < tagSize);
      this.trigger('data', tag);
    };
  };
  MetadataStream.prototype = new muxjs.Stream();

  muxjs.MetadataStream = MetadataStream;
})(window, window.muxjs);

(function() {
  var
    H264ExtraData,
    ExpGolomb = window.muxjs.ExpGolomb,
    FlvTag = window.muxjs.FlvTag;

  window.muxjs.H264ExtraData = H264ExtraData = function() {
    this.sps = []; // :Array
    this.pps = []; // :Array
  };

  H264ExtraData.prototype.extraDataExists = function() { // :Boolean
    return this.sps.length > 0;
  };

  // (sizeOfScalingList:int, expGolomb:ExpGolomb):void
  H264ExtraData.prototype.scaling_list = function(sizeOfScalingList, expGolomb) {
    var
      lastScale = 8, // :int
      nextScale = 8, // :int
      j,
      delta_scale; // :int

    for (j = 0; j < sizeOfScalingList; ++j) {
      if (0 !== nextScale) {
        delta_scale = expGolomb.readExpGolomb();
        nextScale = (lastScale + delta_scale + 256) % 256;
        //useDefaultScalingMatrixFlag = ( j = = 0 && nextScale = = 0 )
      }

      lastScale = (nextScale === 0) ? lastScale : nextScale;
      // scalingList[ j ] = ( nextScale == 0 ) ? lastScale : nextScale;
      // lastScale = scalingList[ j ]
    }
  };

  /**
   * RBSP: raw bit-stream payload. The actual encoded video data.
   *
   * SPS: sequence parameter set. Part of the RBSP. Metadata to be applied
   * to a complete video sequence, like width and height.
   */
  H264ExtraData.prototype.getSps0Rbsp = function() { // :ByteArray
    var
      sps = this.sps[0],
      offset = 1,
      start = 1,
      written = 0,
      end = sps.byteLength - 2,
      result = new Uint8Array(sps.byteLength);

    // In order to prevent 0x0000 01 from being interpreted as a
    // NAL start code, occurences of that byte sequence in the
    // RBSP are escaped with an "emulation byte". That turns
    // sequences of 0x0000 01 into 0x0000 0301. When interpreting
    // a NAL payload, they must be filtered back out.
    while (offset < end) {
      if (sps[offset]     === 0x00 &&
          sps[offset + 1] === 0x00 &&
          sps[offset + 2] === 0x03) {
        result.set(sps.subarray(start, offset + 1), written);
        written += offset + 1 - start;
        start = offset + 3;
      }
      offset++;
    }
    result.set(sps.subarray(start), written);
    return result.subarray(0, written + (sps.byteLength - start));
  };

  // (pts:uint):FlvTag
  H264ExtraData.prototype.metaDataTag = function(pts) {
    var
      tag = new FlvTag(FlvTag.METADATA_TAG), // :FlvTag
      expGolomb, // :ExpGolomb
      profile_idc, // :int
      chroma_format_idc, // :int
      imax, // :int
      i, // :int

      pic_order_cnt_type, // :int
      num_ref_frames_in_pic_order_cnt_cycle, // :uint

      pic_width_in_mbs_minus1, // :int
      pic_height_in_map_units_minus1, // :int

      frame_mbs_only_flag, // :int
      frame_cropping_flag, // :Boolean

      frame_crop_left_offset = 0, // :int
      frame_crop_right_offset = 0, // :int
      frame_crop_top_offset = 0, // :int
      frame_crop_bottom_offset = 0, // :int

      width,
      height;

      tag.dts = pts;
      tag.pts = pts;
      expGolomb = new ExpGolomb(this.getSps0Rbsp());

    // :int = expGolomb.readUnsignedByte(); // profile_idc u(8)
    profile_idc = expGolomb.readUnsignedByte();

    // constraint_set[0-5]_flag, u(1), reserved_zero_2bits u(2), level_idc u(8)
    expGolomb.skipBits(16);

    // seq_parameter_set_id
    expGolomb.skipUnsignedExpGolomb();

    if (profile_idc === 100 ||
        profile_idc === 110 ||
        profile_idc === 122 ||
        profile_idc === 244 ||
        profile_idc === 44 ||
        profile_idc === 83 ||
        profile_idc === 86 ||
        profile_idc === 118 ||
        profile_idc === 128) {
      chroma_format_idc = expGolomb.readUnsignedExpGolomb();
      if (3 === chroma_format_idc) {
        expGolomb.skipBits(1); // separate_colour_plane_flag
      }
      expGolomb.skipUnsignedExpGolomb(); // bit_depth_luma_minus8
      expGolomb.skipUnsignedExpGolomb(); // bit_depth_chroma_minus8
      expGolomb.skipBits(1); // qpprime_y_zero_transform_bypass_flag
      if (expGolomb.readBoolean()) { // seq_scaling_matrix_present_flag
        imax = (chroma_format_idc !== 3) ? 8 : 12;
        for (i = 0 ; i < imax ; ++i) {
          if (expGolomb.readBoolean()) { // seq_scaling_list_present_flag[ i ]
            if (i < 6) {
              this.scaling_list(16, expGolomb);
            } else {
              this.scaling_list(64, expGolomb);
            }
          }
        }
      }
    }

    expGolomb.skipUnsignedExpGolomb(); // log2_max_frame_num_minus4
    pic_order_cnt_type = expGolomb.readUnsignedExpGolomb();

    if ( 0 === pic_order_cnt_type ) {
      expGolomb.readUnsignedExpGolomb(); //log2_max_pic_order_cnt_lsb_minus4
    } else if ( 1 === pic_order_cnt_type ) {
      expGolomb.skipBits(1); // delta_pic_order_always_zero_flag
      expGolomb.skipExpGolomb(); // offset_for_non_ref_pic
      expGolomb.skipExpGolomb(); // offset_for_top_to_bottom_field
      num_ref_frames_in_pic_order_cnt_cycle = expGolomb.readUnsignedExpGolomb();
      for(i = 0 ; i < num_ref_frames_in_pic_order_cnt_cycle ; ++i) {
        expGolomb.skipExpGolomb(); // offset_for_ref_frame[ i ]
      }
    }

    expGolomb.skipUnsignedExpGolomb(); // max_num_ref_frames
    expGolomb.skipBits(1); // gaps_in_frame_num_value_allowed_flag
    pic_width_in_mbs_minus1 = expGolomb.readUnsignedExpGolomb();
    pic_height_in_map_units_minus1 = expGolomb.readUnsignedExpGolomb();

    frame_mbs_only_flag = expGolomb.readBits(1);
    if (0 === frame_mbs_only_flag) {
      expGolomb.skipBits(1); // mb_adaptive_frame_field_flag
    }

    expGolomb.skipBits(1); // direct_8x8_inference_flag
    frame_cropping_flag = expGolomb.readBoolean();
    if (frame_cropping_flag) {
      frame_crop_left_offset = expGolomb.readUnsignedExpGolomb();
      frame_crop_right_offset = expGolomb.readUnsignedExpGolomb();
      frame_crop_top_offset = expGolomb.readUnsignedExpGolomb();
      frame_crop_bottom_offset = expGolomb.readUnsignedExpGolomb();
    }

    width = ((pic_width_in_mbs_minus1 + 1) * 16) - frame_crop_left_offset * 2 - frame_crop_right_offset * 2;
    height = ((2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1) * 16) - (frame_crop_top_offset * 2) - (frame_crop_bottom_offset * 2);

    tag.writeMetaDataDouble("videocodecid", 7);
    tag.writeMetaDataDouble("width", width);
    tag.writeMetaDataDouble("height", height);
    // tag.writeMetaDataDouble("videodatarate", 0 );
    // tag.writeMetaDataDouble("framerate", 0);

    return tag;
  };

  // (pts:uint):FlvTag
  H264ExtraData.prototype.extraDataTag = function(pts) {
    var
      i,
      tag = new FlvTag(FlvTag.VIDEO_TAG, true);

    tag.dts = pts;
    tag.pts = pts;

    tag.writeByte(0x01);// version
    tag.writeByte(this.sps[0][1]);// profile
    tag.writeByte(this.sps[0][2]);// compatibility
    tag.writeByte(this.sps[0][3]);// level
    tag.writeByte(0xFC | 0x03); // reserved (6 bits), NULA length size - 1 (2 bits)
    tag.writeByte(0xE0 | 0x01 ); // reserved (3 bits), num of SPS (5 bits)
    tag.writeShort( this.sps[0].length ); // data of SPS
    tag.writeBytes( this.sps[0] ); // SPS

    tag.writeByte( this.pps.length ); // num of PPS (will there ever be more that 1 PPS?)
    for (i = 0 ; i < this.pps.length ; ++i) {
      tag.writeShort(this.pps[i].length); // 2 bytes for length of PPS
      tag.writeBytes(this.pps[i]); // data of PPS
    }

    return tag;
  };
})();

(function(window) {
  var
    FlvTag = muxjs.FlvTag,
    H264Stream = muxjs.H264Stream,
    AacStream = muxjs.AacStream,
    MetadataStream = muxjs.MetadataStream,
    MP2T_PACKET_LENGTH,
    STREAM_TYPES;

  /**
   * An object that incrementally transmuxes MPEG2 Trasport Stream
   * chunks into an FLV.
   */
  muxjs.SegmentParser = function() {
    var
      self = this,
      parseTSPacket,
      streamBuffer = new Uint8Array(MP2T_PACKET_LENGTH),
      streamBufferByteCount = 0,
      h264Stream = new H264Stream(),
      aacStream = new AacStream();

    // expose the stream metadata
    self.stream = {
      // the mapping between transport stream programs and the PIDs
      // that form their elementary streams
      programMapTable: {}
    };

    // allow in-band metadata to be observed
    self.metadataStream = new MetadataStream();

    // For information on the FLV format, see
    // http://download.macromedia.com/f4v/video_file_format_spec_v10_1.pdf.
    // Technically, this function returns the header and a metadata FLV tag
    // if duration is greater than zero
    // duration in seconds
    // @return {object} the bytes of the FLV header as a Uint8Array
    self.getFlvHeader = function(duration, audio, video) { // :ByteArray {
      var
        headBytes = new Uint8Array(3 + 1 + 1 + 4),
        head = new DataView(headBytes.buffer),
        metadata,
        result,
        metadataLength;

      // default arguments
      duration = duration || 0;
      audio = audio === undefined? true : audio;
      video = video === undefined? true : video;

      // signature
      head.setUint8(0, 0x46); // 'F'
      head.setUint8(1, 0x4c); // 'L'
      head.setUint8(2, 0x56); // 'V'

      // version
      head.setUint8(3, 0x01);

      // flags
      head.setUint8(4, (audio ? 0x04 : 0x00) | (video ? 0x01 : 0x00));

      // data offset, should be 9 for FLV v1
      head.setUint32(5, headBytes.byteLength);

      // init the first FLV tag
      if (duration <= 0) {
        // no duration available so just write the first field of the first
        // FLV tag
        result = new Uint8Array(headBytes.byteLength + 4);
        result.set(headBytes);
        result.set([0, 0, 0, 0], headBytes.byteLength);
        return result;
      }

      // write out the duration metadata tag
      metadata = new FlvTag(FlvTag.METADATA_TAG);
      metadata.pts = metadata.dts = 0;
      metadata.writeMetaDataDouble("duration", duration);
      metadataLength = metadata.finalize().length;
      result = new Uint8Array(headBytes.byteLength + metadataLength);
      result.set(headBytes);
      result.set(head.byteLength, metadataLength);

      return result;
    };

    self.flushTags = function() {
      h264Stream.finishFrame();
    };

    /**
     * Returns whether a call to `getNextTag()` will be successful.
     * @return {boolean} whether there is at least one transmuxed FLV
     * tag ready
     */
    self.tagsAvailable = function() { // :int {
      return h264Stream.tags.length + aacStream.tags.length;
    };

    /**
     * Returns the next tag in decoder-timestamp (DTS) order.
     * @returns {object} the next tag to decoded.
     */
    self.getNextTag = function() {
      var tag;

      if (!h264Stream.tags.length) {
        // only audio tags remain
        tag = aacStream.tags.shift();
      } else if (!aacStream.tags.length) {
        // only video tags remain
        tag = h264Stream.tags.shift();
      } else if (aacStream.tags[0].dts < h264Stream.tags[0].dts) {
        // audio should be decoded next
        tag = aacStream.tags.shift();
      } else {
        // video should be decoded next
        tag = h264Stream.tags.shift();
      }

      return tag.finalize();
    };

    self.parseSegmentBinaryData = function(data) { // :ByteArray) {
      var
        dataPosition = 0,
        dataSlice;

      // To avoid an extra copy, we will stash overflow data, and only
      // reconstruct the first packet. The rest of the packets will be
      // parsed directly from data
      if (streamBufferByteCount > 0) {
        if (data.byteLength + streamBufferByteCount < MP2T_PACKET_LENGTH) {
          // the current data is less than a single m2ts packet, so stash it
          // until we receive more

          // ?? this seems to append streamBuffer onto data and then just give up. I'm not sure why that would be interesting.
          console.log('data.length + streamBuffer.length < MP2T_PACKET_LENGTH ??');
          streamBuffer.readBytes(data, data.length, streamBuffer.length);
          return;
        } else {
          // we have enough data for an m2ts packet
          // process it immediately
          dataSlice = data.subarray(0, MP2T_PACKET_LENGTH - streamBufferByteCount);
          streamBuffer.set(dataSlice, streamBufferByteCount);

          parseTSPacket(streamBuffer);

          // reset the buffer
          streamBuffer = new Uint8Array(MP2T_PACKET_LENGTH);
          streamBufferByteCount = 0;
        }
      }

      while (true) {
        // Make sure we are TS aligned
        while(dataPosition < data.byteLength  && data[dataPosition] !== 0x47) {
          // If there is no sync byte skip forward until we find one
          // TODO if we find a sync byte, look 188 bytes in the future (if
          // possible). If there is not a sync byte there, keep looking
          dataPosition++;
        }

        // base case: not enough data to parse a m2ts packet
        if (data.byteLength - dataPosition < MP2T_PACKET_LENGTH) {
          if (data.byteLength - dataPosition > 0) {
            // there are bytes remaining, save them for next time
            streamBuffer.set(data.subarray(dataPosition),
                             streamBufferByteCount);
            streamBufferByteCount += data.byteLength - dataPosition;
          }
          return;
        }

        // attempt to parse a m2ts packet
        if (parseTSPacket(data.subarray(dataPosition, dataPosition + MP2T_PACKET_LENGTH))) {
          dataPosition += MP2T_PACKET_LENGTH;
        } else {
          // If there was an error parsing a TS packet. it could be
          // because we are not TS packet aligned. Step one forward by
          // one byte and allow the code above to find the next
          console.log('error parsing m2ts packet, attempting to re-align');
          dataPosition++;
        }
      }
    };

    /**
     * Parses a video/mp2t packet and appends the underlying video and
     * audio data onto h264stream and aacStream, respectively.
     * @param data {Uint8Array} the bytes of an MPEG2-TS packet,
     * including the sync byte.
     * @return {boolean} whether a valid packet was encountered
     */
    // TODO add more testing to make sure we dont walk past the end of a TS
    // packet!
    parseTSPacket = function(data) { // :ByteArray):Boolean {
      var
        offset = 0, // :uint
        end = offset + MP2T_PACKET_LENGTH, // :uint

        // Payload Unit Start Indicator
        pusi = !!(data[offset + 1] & 0x40), // mask: 0100 0000

        // packet identifier (PID), a unique identifier for the elementary
        // stream this packet describes
        pid = (data[offset + 1] & 0x1F) << 8 | data[offset + 2], // mask: 0001 1111

        // adaptation_field_control, whether this header is followed by an
        // adaptation field, a payload, or both
        afflag = (data[offset + 3] & 0x30 ) >>> 4,

        patTableId, // :int
        patCurrentNextIndicator, // Boolean
        patSectionLength, // :uint
        programNumber, // :uint
        programPid, // :uint
        patEntriesEnd, // :uint

        pesPacketSize, // :int,
        dataAlignmentIndicator, // :Boolean,
        ptsDtsIndicator, // :int
        pesHeaderLength, // :int

        pts, // :uint
        dts, // :uint

        pmtCurrentNextIndicator, // :Boolean
        pmtProgramDescriptorsLength,
        pmtSectionLength, // :uint

        streamType, // :int
        elementaryPID, // :int
        ESInfolength; // :int

      // Continuity Counter we could use this for sanity check, and
      // corrupt stream detection
      // cc = (data[offset + 3] & 0x0F);

      // move past the header
      offset += 4;

      // if an adaption field is present, its length is specified by
      // the fifth byte of the PES header. The adaptation field is
      // used to specify some forms of timing and control data that we
      // do not currently use.
      if (afflag > 0x01) {
        offset += data[offset] + 1;
      }

      // Handle a Program Association Table (PAT). PATs map PIDs to
      // individual programs. If this transport stream was being used
      // for television broadcast, a program would probably be
      // equivalent to a channel. In HLS, it would be very unusual to
      // create an mp2t stream with multiple programs.
      if (0x0000 === pid) {
        // The PAT may be split into multiple sections and those
        // sections may be split into multiple packets. If a PAT
        // section starts in this packet, PUSI will be true and the
        // first byte of the playload will indicate the offset from
        // the current position to the start of the section.
        if (pusi) {
          offset += 1 + data[offset];
        }
        patTableId = data[offset];

        if (patTableId !== 0x00) {
          console.log('the table_id of the PAT should be 0x00 but was' +
                      patTableId.toString(16));
        }

        // the current_next_indicator specifies whether this PAT is
        // currently applicable or is part of the next table to become
        // active
        patCurrentNextIndicator = !!(data[offset + 5] & 0x01);
        if (patCurrentNextIndicator) {
          // section_length specifies the number of bytes following
          // its position to the end of this section
          // section_length = rest of header + (n * entry length) + CRC
          // = 5 + (n * 4) + 4
          patSectionLength =  (data[offset + 1] & 0x0F) << 8 | data[offset + 2];
          // move past the rest of the PSI header to the first program
          // map table entry
          offset += 8;

          // we don't handle streams with more than one program, so
          // raise an exception if we encounter one
          patEntriesEnd = offset + (patSectionLength - 5 - 4);
          for (; offset < patEntriesEnd; offset += 4) {
            programNumber = (data[offset] << 8 | data[offset + 1]);
            programPid = (data[offset + 2] & 0x1F) << 8 | data[offset + 3];
            // network PID program number equals 0
            // this is primarily an artifact of EBU DVB and can be ignored
            if (programNumber === 0) {
              self.stream.networkPid = programPid;
            } else if (self.stream.pmtPid === undefined) {
              // the Program Map Table (PMT) associates the underlying
              // video and audio streams with a unique PID
              self.stream.pmtPid = programPid;
            } else if (self.stream.pmtPid !== programPid) {
              throw new Error("TS has more that 1 program");
            }
          }
        }
      } else if (pid === self.stream.programMapTable[STREAM_TYPES.h264] ||
                 pid === self.stream.programMapTable[STREAM_TYPES.adts] ||
                 pid === self.stream.programMapTable[STREAM_TYPES.metadata]) {
        if (pusi) {
          // comment out for speed
          if (0x00 !== data[offset + 0] || 0x00 !== data[offset + 1] || 0x01 !== data[offset + 2]) {
            // look for PES start code
             throw new Error("PES did not begin with start code");
           }

          // var sid:int  = data[offset+3]; // StreamID
          pesPacketSize = (data[offset + 4] << 8) | data[offset + 5];
          dataAlignmentIndicator = (data[offset + 6] & 0x04) !== 0;
          ptsDtsIndicator = data[offset + 7];
          pesHeaderLength = data[offset + 8]; // TODO sanity check header length
          offset += 9; // Skip past PES header

          // PTS and DTS are normially stored as a 33 bit number.
          // JavaScript does not have a integer type larger than 32 bit
          // BUT, we need to convert from 90ns to 1ms time scale anyway.
          // so what we are going to do instead, is drop the least
          // significant bit (the same as dividing by two) then we can
          // divide by 45 (45 * 2 = 90) to get ms.
          if (ptsDtsIndicator & 0xC0) {
            // the PTS and DTS are not written out directly. For information on
            // how they are encoded, see
            // http://dvd.sourceforge.net/dvdinfo/pes-hdr.html
            pts = (data[offset + 0] & 0x0E) << 28
              | (data[offset + 1] & 0xFF) << 21
              | (data[offset + 2] & 0xFE) << 13
              | (data[offset + 3] & 0xFF) <<  6
              | (data[offset + 4] & 0xFE) >>>  2;
            pts /= 45;
            dts = pts;
            if (ptsDtsIndicator & 0x40) {// DTS
              dts = (data[offset + 5] & 0x0E ) << 28
                | (data[offset + 6] & 0xFF ) << 21
                | (data[offset + 7] & 0xFE ) << 13
                | (data[offset + 8] & 0xFF ) << 6
                | (data[offset + 9] & 0xFE ) >>> 2;
              dts /= 45;
            }
          }

          // Skip past "optional" portion of PTS header
          offset += pesHeaderLength;

          if (pid === self.stream.programMapTable[STREAM_TYPES.h264]) {
            h264Stream.setNextTimeStamp(pts,
                                        dts,
                                        dataAlignmentIndicator);
          } else if (pid === self.stream.programMapTable[STREAM_TYPES.adts]) {
            aacStream.setNextTimeStamp(pts,
                                       pesPacketSize,
                                       dataAlignmentIndicator);
          }
        }

        if (pid === self.stream.programMapTable[STREAM_TYPES.adts]) {
          aacStream.writeBytes(data, offset, end - offset);
        } else if (pid === self.stream.programMapTable[STREAM_TYPES.h264]) {
          h264Stream.writeBytes(data, offset, end - offset);
        } else if (pid === self.stream.programMapTable[STREAM_TYPES.metadata]) {
          self.metadataStream.push({
            pts: pts,
            dts: dts,
            data: data.subarray(offset)
          });
        }
      } else if (self.stream.pmtPid === pid) {
        // similarly to the PAT, jump to the first byte of the section
        if (pusi) {
          offset += 1 + data[offset];
        }
        if (data[offset] !== 0x02) {
          console.log('The table_id of a PMT should be 0x02 but was ' +
                      data[offset].toString(16));
        }

        // whether this PMT is currently applicable or is part of the
        // next table to become active
        pmtCurrentNextIndicator = !!(data[offset + 5] & 0x01);
        if (pmtCurrentNextIndicator) {
          // overwrite any existing program map table
          self.stream.programMapTable = {};
          // section_length specifies the number of bytes following
          // its position to the end of this section
          pmtSectionLength  = (data[offset + 1] & 0x0f) << 8 | data[offset + 2];
          // subtract the length of the program info descriptors
          pmtProgramDescriptorsLength = (data[offset + 10] & 0x0f) << 8 | data[offset + 11];
          pmtSectionLength -= pmtProgramDescriptorsLength;
          // skip CRC and PSI data we dont care about
          // rest of header + CRC = 9 + 4
          pmtSectionLength -= 13;

          // capture the PID of PCR packets so we can ignore them if we see any
          self.stream.programMapTable.pcrPid = (data[offset + 8] & 0x1f) << 8 | data[offset + 9];

          // align offset to the first entry in the PMT
          offset += 12 + pmtProgramDescriptorsLength;

          // iterate through the entries
          while (0 < pmtSectionLength) {
            // the type of data carried in the PID this entry describes
            streamType = data[offset + 0];
            // the PID for this entry
            elementaryPID = (data[offset + 1] & 0x1F) << 8 | data[offset + 2];

            if (streamType === STREAM_TYPES.h264 &&
                self.stream.programMapTable[streamType] &&
                self.stream.programMapTable[streamType] !== elementaryPID) {
              throw new Error("Program has more than 1 video stream");
            } else if (streamType === STREAM_TYPES.adts &&
                       self.stream.programMapTable[streamType] &&
                       self.stream.programMapTable[streamType] !== elementaryPID) {
              throw new Error("Program has more than 1 audio Stream");
            }
            // add the stream type entry to the map
            self.stream.programMapTable[streamType] = elementaryPID;

            // TODO add support for MP3 audio

            // the length of the entry descriptor
            ESInfolength = (data[offset + 3] & 0x0F) << 8 | data[offset + 4];
            // capture the stream descriptor for metadata streams
            if (streamType === STREAM_TYPES.metadata) {
              self.metadataStream.descriptor = new Uint8Array(data.subarray(offset + 5, offset + 5 + ESInfolength));
            }
            // move to the first byte after the end of this entry
            offset += 5 + ESInfolength;
            pmtSectionLength -=  5 + ESInfolength;
          }
        }
        // We could test the CRC here to detect corruption with extra CPU cost
      } else if (self.stream.networkPid === pid) {
        // network information specific data (NIT) packet
      } else if (0x0011 === pid) {
        // Service Description Table
      } else if (0x1FFF === pid) {
        // NULL packet
      } else if (self.stream.programMapTable.pcrPid) {
        // program clock reference (PCR) PID for the primary program
        // PTS values are sufficient to synchronize playback for us so
        // we can safely ignore these
      } else {
        console.log("Unknown PID parsing TS packet: " + pid);
      }

      return true;
    };

    self.getTags = function() {
      return h264Stream.tags;
    };

    self.stats = {
      h264Tags: function() {
        return h264Stream.tags.length;
      },
      minVideoPts: function() {
        return h264Stream.tags[0].pts;
      },
      maxVideoPts: function() {
        return h264Stream.tags[h264Stream.tags.length - 1].pts;
      },
      aacTags: function() {
        return aacStream.tags.length;
      },
      minAudioPts: function() {
        return aacStream.tags[0].pts;
      },
      maxAudioPts: function() {
        return aacStream.tags[aacStream.tags.length - 1].pts;
      }
    };
  };

  // MPEG2-TS constants
  muxjs.SegmentParser.MP2T_PACKET_LENGTH = MP2T_PACKET_LENGTH = 188;
  muxjs.SegmentParser.STREAM_TYPES = STREAM_TYPES = {
    h264: 0x1b,
    adts: 0x0f,
    metadata: 0x15
  };

})(window);

(function(window, muxjs, undefined){
  'use strict';
  var urlCount = 0,
      EventTarget = videojs.EventTarget,
      defaults,
      VirtualSourceBuffer,
      flvCodec = /video\/flv(;\s*codecs=["']vp6,aac["'])?$/,
      objectUrlPrefix = 'blob:vjs-media-source/',
      interceptBufferCreation,
      addSourceBuffer,
      scheduleTick;

  // ------------
  // Media Source
  // ------------

  defaults = {
    // how to determine the MediaSource implementation to use. There
    // are three available modes:
    // - auto: use native MediaSources where available and Flash
    //   everywhere else
    // - html5: always use native MediaSources
    // - flash: always use the Flash MediaSource polyfill
    mode: 'auto'
  };

  videojs.MediaSource = videojs.extends(EventTarget, {
    constructor: function(options){
      var self;

      this.settings_ = videojs.mergeOptions(defaults, options);

      // determine whether native MediaSources should be used
      if ((this.settings_.mode === 'auto' &&
           videojs.MediaSource.supportsNativeMediaSources()) ||
          this.settings_.mode === 'html5') {
        self = new window.MediaSource();
        interceptBufferCreation(self);
        return self;
      }

      // otherwise, emulate them through the SWF
      return new videojs.FlashMediaSource();
    }
  });
  videojs.MediaSource.supportsNativeMediaSources = function() {
    return !!window.MediaSource;
  };

  // ----
  // HTML
  // ----

  interceptBufferCreation = function(mediaSource) {
    // virtual source buffers will be created as needed to transmux
    // MPEG-2 TS into supported ones
    mediaSource.virtualBuffers = [];

    // intercept calls to addSourceBuffer so video/mp2t can be
    // transmuxed to mp4s
    mediaSource.addSourceBuffer_ = mediaSource.addSourceBuffer;
    mediaSource.addSourceBuffer = addSourceBuffer;
  };

  addSourceBuffer = function(type) {
    var audio, video, buffer;
    // create a virtual source buffer to transmux MPEG-2 transport
    // stream segments into fragmented MP4s
    if (type === 'video/mp2t') {
      audio = this.addSourceBuffer_('audio/mp4;codecs=mp4a.40.2');
      video = this.addSourceBuffer_('video/mp4;codecs=avc1.4d400d');
      buffer = new VirtualSourceBuffer(audio, video)
      this.virtualBuffers.push(buffer);
      return buffer;
    }

    // delegate to the native implementation
    return this.addSourceBuffer_(type);
  };

  VirtualSourceBuffer = videojs.extends(EventTarget, {
    constructor: function VirtualSourceBuffer(audioBuffer, videoBuffer) {
      this.audioBuffer_ = audioBuffer;
      this.audioUpdating_ = false;
      this.videoBuffer_ = videoBuffer;
      this.videoUpdating_ = false;

      // append muxed segments to their respective native buffers as
      // soon as they are available
      this.transmuxer_ = new Worker(URL.createObjectURL(new Blob(["var muxjs={};!function(a,b){b.ExpGolomb=function(a){var b=a.byteLength,c=0,d=0;this.length=function(){return 8*b},this.bitsAvailable=function(){return 8*b+d},this.loadWord=function(){var e=a.byteLength-b,f=new Uint8Array(4),g=Math.min(4,b);if(0===g)throw new Error(\"no bytes available\");f.set(a.subarray(e,e+g)),c=new DataView(f.buffer).getUint32(0),d=8*g,b-=g},this.skipBits=function(a){var e;d>a?(c<<=a,d-=a):(a-=d,e=Math.floor(a/8),a-=8*e,b-=e,this.loadWord(),c<<=a,d-=a)},this.readBits=function(a){var e=Math.min(d,a),f=c>>>32-e;return console.assert(32>a,\"Cannot read more than 32 bits at a time\"),d-=e,d>0?c<<=e:b>0&&this.loadWord(),e=a-e,e>0?f<<e|this.readBits(e):f},this.skipLeadingZeros=function(){var a;for(a=0;d>a;++a)if(0!==(c&2147483648>>>a))return c<<=a,d-=a,a;return this.loadWord(),a+this.skipLeadingZeros()},this.skipUnsignedExpGolomb=function(){this.skipBits(1+this.skipLeadingZeros())},this.skipExpGolomb=function(){this.skipBits(1+this.skipLeadingZeros())},this.readUnsignedExpGolomb=function(){var a=this.skipLeadingZeros();return this.readBits(a+1)-1},this.readExpGolomb=function(){var a=this.readUnsignedExpGolomb();return 1&a?1+a>>>1:-1*(a>>>1)},this.readBoolean=function(){return 1===this.readBits(1)},this.readUnsignedByte=function(){return this.readBits(8)},this.loadWord()}}(this,this.muxjs),function(a,b,c){\"use strict\";var d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P;O=a.Uint8Array,P=a.DataView,function(){var a;A={avc1:[],avcC:[],btrt:[],dinf:[],dref:[],esds:[],ftyp:[],hdlr:[],mdat:[],mdhd:[],mdia:[],mfhd:[],minf:[],moof:[],moov:[],mp4a:[],mvex:[],mvhd:[],sdtp:[],smhd:[],stbl:[],stco:[],stsc:[],stsd:[],stsz:[],stts:[],styp:[],tfdt:[],tfhd:[],traf:[],trak:[],trun:[],trex:[],tkhd:[],vmhd:[]};for(a in A)A.hasOwnProperty(a)&&(A[a]=[a.charCodeAt(0),a.charCodeAt(1),a.charCodeAt(2),a.charCodeAt(3)]);B=new O([\"i\".charCodeAt(0),\"s\".charCodeAt(0),\"o\".charCodeAt(0),\"m\".charCodeAt(0)]),D=new O([\"a\".charCodeAt(0),\"v\".charCodeAt(0),\"c\".charCodeAt(0),\"1\".charCodeAt(0)]),C=new O([0,0,0,1]),E=new O([0,0,0,0,0,0,0,0,118,105,100,101,0,0,0,0,0,0,0,0,0,0,0,0,86,105,100,101,111,72,97,110,100,108,101,114,0]),F=new O([0,0,0,0,0,0,0,0,115,111,117,110,0,0,0,0,0,0,0,0,0,0,0,0,83,111,117,110,100,72,97,110,100,108,101,114,0]),G={video:E,audio:F},J=new O([0,0,0,0,0,0,0,1,0,0,0,12,117,114,108,32,0,0,0,1]),I=new O([0,0,0,0,0,0,0,0]),K=new O([0,0,0,0,0,0,0,0]),L=K,M=new O([0,0,0,0,0,0,0,0,0,0,0,0]),N=K,H=new O([0,0,0,1,0,0,0,0,0,0,0,0])}(),d=function(a){var b,c,d,e=[],f=0;for(b=1;b<arguments.length;b++)e.push(arguments[b]);for(b=e.length;b--;)f+=e[b].byteLength;for(c=new O(f+8),d=new P(c.buffer,c.byteOffset,c.byteLength),d.setUint32(0,c.byteLength),c.set(a,4),b=0,f=8;b<e.length;b++)c.set(e[b],f),f+=e[b].byteLength;return c},e=function(){return d(A.dinf,d(A.dref,J))},f=function(a){return d(A.esds,new O([0,0,0,0,3,25,0,0,0,4,17,64,21,0,6,0,0,0,218,192,0,0,218,192,5,2,a.audioobjecttype<<3|a.samplingfrequencyindex>>>1,a.samplingfrequencyindex<<7|a.channelcount<<3,6,1,2]))},g=function(){return d(A.ftyp,B,C,B,D)},s=function(a){return d(A.hdlr,G[a])},h=function(a){return d(A.mdat,a)},r=function(a){var b=new O([0,0,0,0,0,0,0,2,0,0,0,3,0,1,95,144,a.duration>>>24,a.duration>>>16&255,a.duration>>>8&255,255&a.duration,85,196,0,0]);return a.samplerate&&(b[12]=a.samplerate>>>24,b[13]=a.samplerate>>>16&255,b[14]=a.samplerate>>>8&255,b[15]=255&a.samplerate),d(A.mdhd,b)},q=function(a){return d(A.mdia,r(a),s(a.type),j(a))},i=function(a){return d(A.mfhd,new O([0,0,0,0,(4278190080&a)>>24,(16711680&a)>>16,(65280&a)>>8,255&a]))},j=function(a){return d(A.minf,\"video\"===a.type?d(A.vmhd,H):d(A.smhd,I),e(),u(a))},k=function(a,b){for(var c=[],e=b.length;e--;)c[e]=x(b[e]);return d.apply(null,[A.moof,i(a)].concat(c))},l=function(a){for(var b=a.length,c=[];b--;)c[b]=o(a[b]);return d.apply(null,[A.moov,n(4294967295)].concat(c).concat(m(a)))},m=function(a){for(var b=a.length,c=[];b--;)c[b]=y(a[b]);return d.apply(null,[A.mvex].concat(c))},n=function(a){var b=new O([0,0,0,0,0,0,0,1,0,0,0,2,0,1,95,144,(4278190080&a)>>24,(16711680&a)>>16,(65280&a)>>8,255&a,0,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,64,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255]);return d(A.mvhd,b)},t=function(a){var b,c,e=a.samples||[],f=new O(4+e.length);for(c=0;c<e.length;c++)b=e[c].flags,f[c+4]=b.dependsOn<<4|b.isDependedOn<<2|b.hasRedundancy;return d(A.sdtp,f)},u=function(a){return d(A.stbl,v(a),d(A.stts,N),d(A.stsc,L),d(A.stsz,M),d(A.stco,K))},function(){var a,b;v=function(c){return d(A.stsd,new O([0,0,0,0,0,0,0,1]),\"video\"===c.type?a(c):b(c))},a=function(a){var b,c=a.sps||[],e=a.pps||[],f=[],g=[];for(b=0;b<c.length;b++)f.push((65280&c[b].byteLength)>>>8),f.push(255&c[b].byteLength),f=f.concat(Array.prototype.slice.call(c[b]));for(b=0;b<e.length;b++)g.push((65280&e[b].byteLength)>>>8),g.push(255&e[b].byteLength),g=g.concat(Array.prototype.slice.call(e[b]));return d(A.avc1,new O([0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,(65280&a.width)>>8,255&a.width,(65280&a.height)>>8,255&a.height,0,72,0,0,0,72,0,0,0,0,0,0,0,1,19,118,105,100,101,111,106,115,45,99,111,110,116,114,105,98,45,104,108,115,0,0,0,0,0,0,0,0,0,0,0,0,0,24,17,17]),d(A.avcC,new O([1,a.profileIdc,a.profileCompatibility,a.levelIdc,255].concat([c.length]).concat(f).concat([e.length]).concat(g))),d(A.btrt,new O([0,28,156,128,0,45,198,192,0,45,198,192])))},b=function(a){return d(A.mp4a,new O([0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,(65280&a.channelcount)>>8,255&a.channelcount,(65280&a.samplesize)>>8,255&a.samplesize,0,0,0,0,(65280&a.samplerate)>>8,255&a.samplerate,0,0]),f(a))}}(),w=function(){return d(A.styp,B,C,B)},p=function(a){var b=new O([0,0,0,7,0,0,0,0,0,0,0,0,(4278190080&a.id)>>24,(16711680&a.id)>>16,(65280&a.id)>>8,255&a.id,0,0,0,0,(4278190080&a.duration)>>24,(16711680&a.duration)>>16,(65280&a.duration)>>8,255&a.duration,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,64,0,0,0,(65280&a.width)>>8,255&a.width,0,0,(65280&a.height)>>8,255&a.height,0,0]);return d(A.tkhd,b)},x=function(a){var b,c,e,f,g;return b=d(A.tfhd,new O([0,0,0,58,(4278190080&a.id)>>24,(16711680&a.id)>>16,(65280&a.id)>>8,255&a.id,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0])),c=d(A.tfdt,new O([0,0,0,0,0,0,0,0])),g=88,\"audio\"===a.type?(e=z(a,g),d(A.traf,b,c,e)):(f=t(a),e=z(a,f.length+g),d(A.traf,b,c,e,f))},o=function(a){return a.duration=a.duration||4294967295,d(A.trak,p(a),q(a))},y=function(a){var b=new O([0,0,0,0,(4278190080&a.id)>>24,(16711680&a.id)>>16,(65280&a.id)>>8,255&a.id,0,0,0,1,0,0,0,0,0,0,0,0,0,1,0,1]);return\"video\"!==a.type&&(b[b.length-1]=0),d(A.trex,b)},function(){var a,b,e;e=function(a,b){var d=0,e=0,f=0,g=0;return a.length&&(a[0].duration!==c&&(d=1),a[0].size!==c&&(e=2),a[0].flags!==c&&(f=4),a[0].compositionTimeOffset!==c&&(g=8)),[0,0,d|e|f|g,1,(4278190080&a.length)>>>24,(16711680&a.length)>>>16,(65280&a.length)>>>8,255&a.length,(4278190080&b)>>>24,(16711680&b)>>>16,(65280&b)>>>8,255&b]},b=function(a,b){var c,f,g,h;for(f=a.samples||[],b+=20+16*f.length,c=e(f,b),h=0;h<f.length;h++)g=f[h],c=c.concat([(4278190080&g.duration)>>>24,(16711680&g.duration)>>>16,(65280&g.duration)>>>8,255&g.duration,(4278190080&g.size)>>>24,(16711680&g.size)>>>16,(65280&g.size)>>>8,255&g.size,g.flags.isLeading<<2|g.flags.dependsOn,g.flags.isDependedOn<<6|g.flags.hasRedundancy<<4|g.flags.paddingValue<<1|g.flags.isNonSyncSample,61440&g.flags.degradationPriority,15&g.flags.degradationPriority,(4278190080&g.compositionTimeOffset)>>>24,(16711680&g.compositionTimeOffset)>>>16,(65280&g.compositionTimeOffset)>>>8,255&g.compositionTimeOffset]);return d(A.trun,new O(c))},a=function(a,b){var c,f,g,h;for(f=a.samples||[],b+=20+8*f.length,c=e(f,b),h=0;h<f.length;h++)g=f[h],c=c.concat([(4278190080&g.duration)>>>24,(16711680&g.duration)>>>16,(65280&g.duration)>>>8,255&g.duration,(4278190080&g.size)>>>24,(16711680&g.size)>>>16,(65280&g.size)>>>8,255&g.size]);return d(A.trun,new O(c))},z=function(c,d){return\"audio\"===c.type?a(c,d):b(c,d)}}(),b.mp4={ftyp:g,mdat:h,moof:k,moov:l,initSegment:function(a){var b,c=g(),d=l(a);return b=new O(c.byteLength+d.byteLength),b.set(c),b.set(d,c.byteLength),b}}}(this,this.muxjs),function(a,b){var c=function(){this.init=function(){var a={};this.on=function(b,c){a[b]||(a[b]=[]),a[b].push(c)},this.off=function(b,c){var d;return a[b]?(d=a[b].indexOf(c),a[b].splice(d,1),d>-1):!1},this.trigger=function(b){var c,d,e,f;if(c=a[b])if(2===arguments.length)for(e=c.length,d=0;e>d;++d)c[d].call(this,arguments[1]);else{for(f=[],d=arguments.length,d=1;d<arguments.length;++d)f.push(arguments[d]);for(e=c.length,d=0;e>d;++d)c[d].apply(this,f)}},this.dispose=function(){a={}}}};c.prototype.pipe=function(a){this.on(\"data\",function(b){a.push(b)})},a.muxjs=a.muxjs||{},a.muxjs.Stream=c}(this),function(a,b,c){\"use strict\";var d,e,f,g,h,i,j,k,l,m,n,o,p,q;m=188,n=27,o=15,p=[96e3,88200,64e3,48e3,44100,32e3,24e3,22050,16e3,12e3,11025,8e3,7350],q=b.mp4,d=function(){var a=new Uint8Array(m),b=0;d.prototype.init.call(this),this.push=function(c){var d,e;if(b>0){if(d=m-b,a.set(c.subarray(0,d),b),c.byteLength<d)return void(b+=c.byteLength);c=c.subarray(d),b=0,this.trigger(\"data\",a)}if(c.byteLength<m)return a.set(c.subarray(e),b),void(b+=c.byteLength);e=0;do this.trigger(\"data\",c.subarray(e,e+m)),e+=m,d=c.byteLength-e;while(e<c.byteLength&&d>=m);d>0&&(a.set(c.subarray(e)),b=d)}},d.prototype=new b.Stream,e=function(){var a,b,c,d,f;e.prototype.init.call(this),f=this,this.programMapTable={},a=function(a,d){var e=0;d.payloadUnitStartIndicator&&(e+=a[e]+1),\"pat\"===d.type?b(a.subarray(e),d):c(a.subarray(e),d)},b=function(a,b){b.section_number=a[7],b.last_section_number=a[8],f.pmtPid=(31&a[10])<<8|a[11],b.pmtPid=f.pmtPid},c=function(a,b){var c,d,e,g;if(1&a[5]){for(f.programMapTable={},c=(15&a[1])<<8|a[2],d=3+c-4,e=(15&a[10])<<8|a[11],g=12+e;d>g;)f.programMapTable[(31&a[g+1])<<8|a[g+2]]=a[g],g+=((15&a[g+3])<<8|a[g+4])+5;b.programMapTable=f.programMapTable}},d=function(a,b){var c;return b.payloadUnitStartIndicator?(b.dataAlignmentIndicator=0!==(4&a[6]),c=a[7],192&c&&(b.pts=(14&a[9])<<28|(255&a[10])<<21|(254&a[11])<<13|(255&a[12])<<6|(254&a[13])>>>2,b.pts*=2,b.pts+=2&a[13],b.dts=b.pts,64&c&&(b.dts=(14&a[14])<<28|(255&a[15])<<21|(254&a[16])<<13|(255&a[17])<<6|(254&a[18])>>>2,b.dts*=2,b.dts+=2&a[18])),void(b.data=a.subarray(9+a[8]))):void(b.data=a)},this.push=function(b){var c={},e=4;return 71!==b[0]?this.trigger(\"error\",\"mis-aligned packet\"):(c.payloadUnitStartIndicator=!!(64&b[1]),c.pid=31&b[1],c.pid<<=8,c.pid|=b[2],(48&b[3])>>>4>1&&(e+=b[e]+1),0===c.pid?(c.type=\"pat\",a(b.subarray(e),c)):c.pid===this.pmtPid?(c.type=\"pmt\",a(b.subarray(e),c)):(c.streamType=this.programMapTable[c.pid],c.type=\"pes\",d(b.subarray(e),c)),void this.trigger(\"data\",c))}},e.prototype=new b.Stream,e.STREAM_TYPES={h264:27,adts:15},f=function(){var a,b={data:[],size:0},c={data:[],size:0},d=function(b,c){var d,e={type:c,data:new Uint8Array(b.size)},f=0;if(b.data.length){for(e.trackId=b.data[0].pid,e.pts=b.data[0].pts,e.dts=b.data[0].dts;b.data.length;)d=b.data.shift(),e.data.set(d.data,f),f+=d.data.byteLength;b.size=0,a.trigger(\"data\",e)}};f.prototype.init.call(this),a=this,this.push=function(e){({pat:function(){},pes:function(){var a,f;switch(e.streamType){case n:a=b,f=\"video\";break;case o:a=c,f=\"audio\";break;default:return}e.payloadUnitStartIndicator&&d(a,f),a.data.push(e),a.size+=e.data.byteLength},pmt:function(){var b,c,d={type:\"metadata\",tracks:[]},f=e.programMapTable;for(b in f)f.hasOwnProperty(b)&&(c={},c.id=+b,f[b]===n?(c.codec=\"avc\",c.type=\"video\"):f[b]===o&&(c.codec=\"adts\",c.type=\"audio\"),d.tracks.push(c));a.trigger(\"data\",d)}})[e.type]()},this.flush=function(){d(b,\"video\"),d(c,\"audio\")}},f.prototype=new b.Stream,j=function(){var a,b,c=1;j.prototype.init.call(this),a=this,this.push=function(a){var d;if(\"audio\"===a.type)for(b=a.data;c+4<b.length;)d=(3&b[c+2])<<11|b[c+3]<<3|(224&b[c+4])>>5,this.trigger(\"data\",{audioobjecttype:(b[c+1]>>>6&3)+1,channelcount:(1&b[c+1])<<3|(192&b[c+2])>>>6,samplerate:p[(60&b[c+1])>>>2],samplingfrequencyindex:(60&b[c+1])>>>2,samplesize:16,data:b.subarray(c+6,c+d-1)}),b=b.subarray(c+d-1),c=1}},j.prototype=new b.Stream,h=function(a){var b=[],c=0,d=0;h.prototype.init.call(this),this.push=function(a){b.push(a),c+=a.data.byteLength},this.flush=function(){var e,f,g,h,i,j,k;if(0!==c){for(g=new Uint8Array(c),a.samples=[],i=0;b.length;)f=b[0],h={size:f.data.byteLength,duration:1024},a.samples.push(h),g.set(f.data,i),i+=f.data.byteLength,b.shift();c=0,j=q.mdat(g),k=q.moof(d,[a]),e=new Uint8Array(k.byteLength+j.byteLength),d++,e.set(k),e.set(j,k.byteLength),this.trigger(\"data\",e)}}},h.prototype=new b.Stream,l=function(){var a,b,c=1;l.prototype.init.call(this),this.push=function(d){var e;for(b?(e=new Uint8Array(b.byteLength+d.data.byteLength),e.set(b),e.set(d.data,b.byteLength),b=e):b=d.data;c<b.byteLength-3;c++)if(1===b[c+2]){a=c+5;break}for(;a<b.byteLength;)switch(b[a]){case 0:if(0!==b[a-1]){a+=2;break}if(0!==b[a-2]){a++;break}this.trigger(\"data\",b.subarray(c+3,a-2));do a++;while(1!==b[a]&&a<b.length);c=a-2,a+=3;break;case 1:if(0!==b[a-1]||0!==b[a-2]){a+=3;break}this.trigger(\"data\",b.subarray(c+3,a-2)),c=a-2,a+=3;break;default:a+=3}b=b.subarray(c),a-=c,c=0},this.flush=function(){b&&b.byteLength>3&&this.trigger(\"data\",b.subarray(c+3)),b=null,c=1}},l.prototype=new b.Stream,k=function(){var a,c,d,e,f,g,h,i=new l;k.prototype.init.call(this),a=this,this.push=function(a){\"video\"===a.type&&(c=a.trackId,d=a.pts,e=a.dts,i.push(a))},i.on(\"data\",function(b){var h={trackId:c,pts:d,dts:e,data:b};switch(31&b[0]){case 5:h.nalUnitType=\"slice_layer_without_partitioning_rbsp_idr\";break;case 7:h.nalUnitType=\"seq_parameter_set_rbsp\",h.escapedRBSP=f(b.subarray(1)),h.config=g(h.escapedRBSP);break;case 8:h.nalUnitType=\"pic_parameter_set_rbsp\";break;case 9:h.nalUnitType=\"access_unit_delimiter_rbsp\"}a.trigger(\"data\",h)}),this.flush=function(){i.flush()},h=function(a,b){var c,d,e=8,f=8;for(c=0;a>c;c++)0!==f&&(d=b.readExpGolomb(),f=(e+d+256)%256),e=0===f?e:f},f=function(a){for(var b,c,d=a.byteLength,e=[],f=1;d-2>f;)0===a[f]&&0===a[f+1]&&3===a[f+2]?(e.push(f+2),f+=2):f++;if(0===e.length)return a;b=d-e.length,c=new Uint8Array(b);var g=0;for(f=0;b>f;g++,f++)g===e[0]&&(g++,e.shift()),c[f]=a[g];return c},g=function(a){var c,d,e,f,g,i,j,k,l,m,n,o,p=0,q=0,r=0,s=0;if(c=new b.ExpGolomb(a),d=c.readUnsignedByte(),f=c.readUnsignedByte(),e=c.readUnsignedByte(),c.skipUnsignedExpGolomb(),(100===d||110===d||122===d||244===d||44===d||83===d||86===d||118===d||128===d||138===d||139===d||134===d)&&(g=c.readUnsignedExpGolomb(),3===g&&c.skipBits(1),c.skipUnsignedExpGolomb(),c.skipUnsignedExpGolomb(),c.skipBits(1),c.readBoolean()))for(n=3!==g?8:12,o=0;n>o;o++)c.readBoolean()&&(6>o?h(16,c):h(64,c));if(c.skipUnsignedExpGolomb(),i=c.readUnsignedExpGolomb(),0===i)c.readUnsignedExpGolomb();else if(1===i)for(c.skipBits(1),c.skipExpGolomb(),c.skipExpGolomb(),j=c.readUnsignedExpGolomb(),o=0;j>o;o++)c.skipExpGolomb();return c.skipUnsignedExpGolomb(),c.skipBits(1),k=c.readUnsignedExpGolomb(),l=c.readUnsignedExpGolomb(),m=c.readBits(1),0===m&&c.skipBits(1),c.skipBits(1),c.readBoolean()&&(p=c.readUnsignedExpGolomb(),q=c.readUnsignedExpGolomb(),r=c.readUnsignedExpGolomb(),s=c.readUnsignedExpGolomb()),{profileIdc:d,levelIdc:e,profileCompatibility:f,width:16*(k+1)-2*p-2*q,height:(2-m)*(l+1)*16-2*r-2*s}}},k.prototype=new b.Stream,g=function(a){var b=0,c=[],d=0;g.prototype.init.call(this),this.push=function(a){c.push(a),d+=a.data.byteLength},this.flush=function(){var e,f,g,h,i,j,k,l,m;if(0!==d){for(k=new Uint8Array(d+4*c.length),l=new DataView(k.buffer),a.samples=[],m={size:0,flags:{isLeading:0,dependsOn:1,isDependedOn:0,hasRedundancy:0,degradationPriority:0}},j=0;c.length;)f=c[0],\"access_unit_delimiter_rbsp\"===f.nalUnitType&&(e&&(m.duration=f.dts-e.dts,a.samples.push(m)),m={size:0,flags:{isLeading:0,dependsOn:1,isDependedOn:0,hasRedundancy:0,degradationPriority:0},compositionTimeOffset:f.pts-f.dts},e=f),\"slice_layer_without_partitioning_rbsp_idr\"===f.nalUnitType&&(m.flags.dependsOn=2),m.size+=4,m.size+=f.data.byteLength,l.setUint32(j,f.data.byteLength),j+=4,k.set(f.data,j),j+=f.data.byteLength,c.shift();a.samples.length&&(m.duration=a.samples[a.samples.length-1].duration),a.samples.push(m),d=0,h=q.mdat(k),g=q.moof(b,[a]),i=new Uint8Array(g.byteLength+h.byteLength),b++,i.set(g),i.set(h,g.byteLength),this.trigger(\"data\",i)}}},g.prototype=new b.Stream,i=function(){var a,l,m,n,o,p,q,r,s,t,u,v=this;i.prototype.init.call(this),o=new d,p=new e,q=new f,r=new j,s=new k,o.pipe(p),p.pipe(q),q.pipe(r),q.pipe(s),s.on(\"data\",function(b){\"seq_parameter_set_rbsp\"!==b.nalUnitType||m||(m=b.config,a.width=m.width,a.height=m.height,a.sps=[b.data],a.profileIdc=m.profileIdc,a.levelIdc=m.levelIdc,a.profileCompatibility=m.profileCompatibility),\"pic_parameter_set_rbsp\"!==b.nalUnitType||n||(n=b.data,a.pps=[b.data])}),r.on(\"data\",function(a){l&&l.channelcount===c&&(l.audioobjecttype=a.audioobjecttype,l.channelcount=a.channelcount,l.samplerate=a.samplerate,l.samplingfrequencyindex=a.samplingfrequencyindex,l.samplesize=a.samplesize)}),q.on(\"data\",function(c){var d,e=function(c){var d=\"video\"===c?a:l;return function(a){var e=b.mp4.initSegment([d]),f=new Uint8Array(e.byteLength+a.byteLength);f.set(e),f.set(a,e.byteLength),v.trigger(\"data\",{type:c,data:f})}};if(\"metadata\"===c.type)for(d=c.tracks.length;d--;){if(\"video\"===c.tracks[d].type&&!t){a=c.tracks[d],t=new g(a),s.pipe(t),t.on(\"data\",e(\"video\"));break}\"audio\"!==c.tracks[d].type||u||(l=c.tracks[d],u=new h(l),r.pipe(u),u.on(\"data\",e(\"audio\")))}}),this.push=function(a){o.push(a)},this.flush=function(){q.flush(),s.flush(),t&&t.flush(),u&&u.flush(),this.trigger(\"done\")}},i.prototype=new b.Stream,b.mp2t={PAT_PID:0,MP2T_PACKET_LENGTH:m,H264_STREAM_TYPE:n,ADTS_STREAM_TYPE:o,TransportPacketStream:d,TransportParseStream:e,ElementaryStream:f,VideoSegmentStream:g,Transmuxer:i,AacStream:j,H264Stream:k}}(this,this.muxjs);var transmuxer=new muxjs.mp2t.Transmuxer;onmessage=function(a){if(\"push\"===a.data.action){var b=new Uint8Array(a.data.data);transmuxer.push(b)}else\"flush\"===a.data.action&&transmuxer.flush()},transmuxer.on(\"data\",function(a){postMessage({action:\"data\",type:a.type,data:a.data.buffer},[a.data.buffer])}),transmuxer.on(\"done\",function(a){postMessage({action:\"done\"})});"], {type: "application/javascript"})));

      this.transmuxer_.onmessage = function (event) {
        if (event.data.action === 'data') {
          var
            buffer,
            segment = event.data;
          // Cast to type
          segment.data = new Uint8Array(segment.data);

          if (segment.type === 'video') {
            buffer = this.videoBuffer_;
            this.videoUpdating_ = false;
          } else {
            buffer = this.audioBuffer_;
            this.audioUpdating_ = false;
          }
          if (this.timestampOffset !== undefined) {
            buffer.timestampOffset = this.timestampOffset;
          }

          buffer.appendBuffer(segment.data);
        }
      }.bind(this);

      // this buffer is "updating" if either of its native buffers are
      Object.defineProperty(this, 'updating', {
        get: function() {
          return this.audioUpdating_ || this.videoUpdating_ ||
            this.audioBuffer_.updating || this.videoBuffer_.updating;
        }
      });
      // the buffered property is the intersection of the buffered
      // ranges of the native source buffers
      Object.defineProperty(this, 'buffered', {
        get: function() {
          var start, end;
          if (this.videoBuffer_.buffered.length === 0 ||
              this.audioBuffer_.buffered.length === 0) {
            return videojs.createTimeRange();
          }
          start = Math.max(this.videoBuffer_.buffered.start(0),
                           this.audioBuffer_.buffered.start(0));
          end = Math.min(this.videoBuffer_.buffered.end(0),
                         this.audioBuffer_.buffered.end(0));
          return videojs.createTimeRange(start, end);
        }
      });
    },
    appendBuffer: function(segment) {
      this.audioUpdating_ = this.videoUpdating_ = true;

      this.transmuxer_.postMessage({action: 'push', data: segment.buffer}, [segment.buffer]);
      this.transmuxer_.postMessage({action: 'flush'});
    }
  });

  // -----
  // Flash
  // -----

  videojs.FlashMediaSource = videojs.extends(EventTarget, {
    constructor: function(){
      this.sourceBuffers = [];
      this.readyState = 'closed';

      this.on(['sourceopen', 'webkitsourceopen'], function(event){
        // find the swf where we will push media data
        this.swfObj = document.getElementById(event.swfId);
        this.readyState = 'open';

        // trigger load events
        if (this.swfObj) {
          this.swfObj.vjs_load();
        }
      });
    }
  });

  /**
   * The maximum size in bytes for append operations to the video.js
   * SWF. Calling through to Flash blocks and can be expensive so
   * tuning this parameter may improve playback on slower
   * systems. There are two factors to consider:
   * - Each interaction with the SWF must be quick or you risk dropping
   * video frames. To maintain 60fps for the rest of the page, each append
   * cannot take longer than 16ms. Given the likelihood that the page will
   * be executing more javascript than just playback, you probably want to
   * aim for ~8ms.
   * - Bigger appends significantly increase throughput. The total number of
   * bytes over time delivered to the SWF must exceed the video bitrate or
   * playback will stall.
   *
   * The default is set so that a 4MB/s stream should playback
   * without stuttering.
   */
  videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL = 4 * 1024 * 1024;
  videojs.FlashMediaSource.TICKS_PER_SECOND = 60;

  // create a new source buffer to receive a type of media data
  videojs.FlashMediaSource.prototype.addSourceBuffer = function(type){
    var sourceBuffer;

    // if this is an FLV type, we'll push data to flash
    if (type === 'video/mp2t') {
      // Flash source buffers
      sourceBuffer = new videojs.FlashSourceBuffer(this);
    } else {
      throw new Error('NotSupportedError (Video.js)');
    }

    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  };


  /**
   * Set or return the presentation duration.
   * @param value {double} the duration of the media in seconds
   * @param {double} the current presentation duration
   * @see http://www.w3.org/TR/media-source/#widl-MediaSource-duration
   */
  Object.defineProperty(videojs.FlashMediaSource.prototype, 'duration', {
    get: function(){
      if (!this.swfObj) {
        return NaN;
      }
      // get the current duration from the SWF
      return this.swfObj.vjs_getProperty('duration');
    },
    set: function(value){
      this.swfObj.vjs_setProperty('duration', value);
      return value;
    }
  });

  /**
   * Signals the end of the stream.
   */
  videojs.FlashMediaSource.prototype.endOfStream = function(){
    this.readyState = 'ended';
  };

  // store references to the media sources so they can be connected
  // to a video element (a swf object)
  videojs.mediaSources = {};
  // provide a method for a swf object to notify JS that a media source is now open
  videojs.MediaSource.open = function(msObjectURL, swfId){
    var mediaSource = videojs.mediaSources[msObjectURL];

    if (mediaSource) {
      mediaSource.trigger({
        type: 'sourceopen',
        swfId: swfId
      });
    } else {
      throw new Error('Media Source not found (Video.js)');
    }
  };

  scheduleTick = function(func) {
    // Chrome doesn't invoke requestAnimationFrame callbacks
    // in background tabs, so use setTimeout.
    window.setTimeout(func,
                      Math.ceil(1000 / videojs.FlashMediaSource.TICKS_PER_SECOND));
  };

  // Source Buffer
  videojs.FlashSourceBuffer = videojs.extends(EventTarget, {

    constructor: function(source){
      var encodedHeader;

      // byte arrays queued to be appended
      this.buffer_ = [];

      // the total number of queued bytes
      this.bufferSize_ =  0;

      this.source = source;

      // indicates whether the asynchronous continuation of an operation
      // is still being processed
      // see https://w3c.github.io/media-source/#widl-SourceBuffer-updating
      this.updating = false;

      // TS to FLV transmuxer
      this.segmentParser_ = new muxjs.SegmentParser();
      encodedHeader = window.btoa(String.fromCharCode.apply(null, this.segmentParser_.getFlvHeader()));
      this.source.swfObj.vjs_appendBuffer(encodedHeader);

      Object.defineProperty(this, 'buffered', {
        get: function() {
          return videojs.createTimeRange(0, this.source.swfObj.vjs_getProperty('buffered'));
        }
      });
    },

    // accept video data and pass to the video (swf) object
    appendBuffer: function(uint8Array){
      var error, flvBytes;

      if (this.updating) {
        error = new Error('SourceBuffer.append() cannot be called ' +
                          'while an update is in progress');
        error.name = 'InvalidStateError';
        error.code = 11;
        throw error;
      }
      if (this.buffer_.length === 0) {
        scheduleTick(this.processBuffer_.bind(this));
      }

      this.updating = true;
      this.source.readyState = 'open';
      this.trigger({ type: 'update' });

      flvBytes = this.tsToFlv_(uint8Array);
      this.buffer_.push(flvBytes);
      this.bufferSize_ += flvBytes.byteLength;
    },

    // reset the parser and remove any data queued to be sent to the swf
    abort: function() {
      this.buffer_ = [];
      this.bufferSize_ = 0;
      this.source.swfObj.vjs_abort();

      // report any outstanding updates have ended
      if (this.updating) {
        this.updating = false;
        this.trigger({ type: 'updateend' });
      }

    },

    // append a portion of the current buffer to the SWF
    processBuffer_: function() {
      var chunk, i, length, payload, maxSize, b64str;

      if (!this.buffer_.length) {
        // do nothing if the buffer is empty
        return;
      }

      if (document.hidden) {
        // When the document is hidden, the browser will likely
        // invoke callbacks less frequently than we want. Just
        // append a whole second's worth of data. It doesn't
        // matter if the video janks, since the user can't see it.
        maxSize = videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL;
      } else {
        maxSize = Math.ceil(videojs.FlashMediaSource.BYTES_PER_SECOND_GOAL/
                            videojs.FlashMediaSource.TICKS_PER_SECOND);
      }

      // concatenate appends up to the max append size
      payload = new Uint8Array(Math.min(maxSize, this.bufferSize_));
      i = payload.byteLength;
      while (i) {
        chunk = this.buffer_[0].subarray(0, i);

        payload.set(chunk, payload.byteLength - i);

        // requeue any bytes that won't make it this round
        if (chunk.byteLength < this.buffer_[0].byteLength) {
          this.buffer_[0] = this.buffer_[0].subarray(i);
        } else {
          this.buffer_.shift();
        }

        i -= chunk.byteLength;
      }
      this.bufferSize_ -= payload.byteLength;

      // base64 encode the bytes
      b64str = window.btoa(String.fromCharCode.apply(null, payload));

      // bypass normal ExternalInterface calls and pass xml directly
      // IE can be slow by default
      this.source.swfObj.CallFunction('<invoke name="vjs_appendBuffer"' +
                                      'returntype="javascript"><arguments><string>' +
                                      b64str +
                                      '</string></arguments></invoke>');

      // schedule another append if necessary
      if (this.bufferSize_ !== 0) {
        scheduleTick(this.processBuffer_.bind(this));
      } else {
        this.updating = false;
        this.trigger({ type: 'updateend' });

        if (this.source.readyState === 'ended') {
          this.source.swfObj.vjs_endOfStream();
        }
      }
    },

    // transmux segment data from MP2T to FLV
    tsToFlv_: function(bytes) {
      var segmentByteLength = 0, tags = [],
          i, j, segment;

      // transmux the TS to FLV
      this.segmentParser_.parseSegmentBinaryData(bytes);
      this.segmentParser_.flushTags();

      // assemble the FLV tags in decoder order
      while (this.segmentParser_.tagsAvailable()) {
        tags.push(this.segmentParser_.getNextTag());
      }

      // concatenate the bytes into a single segment
      for (i = 0; i < tags.length; i++) {
        segmentByteLength += tags[i].bytes.byteLength;
      }
      segment = new Uint8Array(segmentByteLength);
      for (i = 0, j = 0; i < tags.length; i++) {
        segment.set(tags[i].bytes, j);
        j += tags[i].bytes.byteLength;
      }
      return segment;
    }
  });

  // URL
  videojs.URL = {
    createObjectURL: function(object){
      var url;

      // if the object isn't an emulated MediaSource, delegate to the
      // native implementation
      if (!(object instanceof videojs.FlashMediaSource)) {
        return window.URL.createObjectURL(object);
      }

      // build a URL that can be used to map back to the emulated
      // MediaSource
      url = objectUrlPrefix + urlCount;

      urlCount++;

      // setup the mapping back to object
      videojs.mediaSources[url] = object;

      return url;
    }
  };

})(this, this.muxjs);
