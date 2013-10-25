/**
 * @fileoverview Segment metadata for DASH media.
 *
 */
window.player = {
  dash:{
  },
  utils:{
  }
};
/**
 * A container for references to (sub)segments. References are guaranteed to be
 * monotonic and contiguous by the underlying file formats (for now).
 *
 * TODO(strobe): Figure out strategy for live.
 *
 * @constructor
 */
player.dash.SegmentIndex = function() {
  /**
   * The total number of segments stored in the index. When 'isCapped_' is
   * set, the offset and start time at the index equal to the count (i.e. last
   * seg num + 1) are valid and point to EOS.
   * @private {number}
   */
  this.count_ = 0;

  /**
   * The absolute byte offsets from the start of the resource to the start of
   * the numbered segment. This value (and startTimes_) grow by doubling for
   * efficient incremental accumulation of new index entries. No Int64 type so
   * these integers are stored in Float64s.
   * @private {Float64Array}
   */
  this.offsets_ = new Float64Array(128);

  /**
   * The start time of the indexed segment.
   * @private {Float32Array}
   */
  this.startTimes_ = new Float32Array(128);

  /**
   * Whether this index is "capped" - meaning that the offset and start time
   * after the last segment point to EOS.
   * @private {boolean}
   */
  this.isCapped_ = false;
};


/**
 * Returns the starting byte offset of a segment.
 * @param {number} segNum Segment number.
 * @return {number} Start time.
 */
player.dash.SegmentIndex.prototype.getOffset = function(segNum) {
  return this.offsets_[segNum];
};


/**
 * Returns the start time of a segment.
 * @param {number} segNum Segment number.
 * @return {number} Start time.
 */
player.dash.SegmentIndex.prototype.getStartTime = function(segNum) {
  return this.startTimes_[segNum];
};


/**
 * Returns the duration of a segment, or -1 if duration is unknown.
 * @param {number} segNum Segment number.
 * @return {number} Duration.
 */
player.dash.SegmentIndex.prototype.getDuration = function(segNum) {
  if (segNum + 1 < this.count_ || this.isCapped_) {
    return this.startTimes_[segNum + 1] - this.startTimes_[segNum];
  }
  return -1;
};


/**
 * Returns the length of a segment, or -1 if length is unknown.
 * @param {number} segNum Segment number.
 * @return {number} Byte length.
 */
player.dash.SegmentIndex.prototype.getByteLength = function(segNum) {
  if (segNum + 1 < this.count_ || this.isCapped_) {
    return this.offsets_[segNum + 1] - this.offsets_[segNum];
  }
  return -1;
};


/**
 * Returns the range of a segment.
 * @param {number} segNum Segment number.
 * @return {yt.player.utils.ByteRange} Byte range.
 */
player.dash.SegmentIndex.prototype.getRange = function(segNum) {
  return yt.player.utils.ByteRange.fromLength(
      this.getOffset(segNum), this.getByteLength(segNum));
};


/**
 * Returns the number of segments in this index.
 * @return {number} Segment count.
 */
player.dash.SegmentIndex.prototype.getCount = function() {
  return this.count_;
};


/**
 * Returns the total duration of the media in the index.
 * @return {number} Total duration.
 */
player.dash.SegmentIndex.prototype.getTotalDuration = function() {
  return this.isCapped_ ? this.startTimes_[this.count_] : -1;
};


/**
 * Returns the total length of the media in the index.
 * @return {number} Total byte length.
 */
player.dash.SegmentIndex.prototype.getTotalByteLength = function() {
  return this.isCapped_ ? this.offsets_[this.count_] : -1;
};


/**
 * Returns the segment number which begins no later than the provided time.
 * @param {number} time Time to search for.
 * @return {number} Segment number.
 */
player.dash.SegmentIndex.prototype.findForTime = function(time) {
  var idx = this.count_ - 1;
  for (var i = 0; i < this.count_; i++) {
    if (this.startTimes_[i] > time) {
      idx = i - 1;
      break;
    }
  }
  return idx;
};


/**
 * Resizes the segment index to include more places for media information.
 * Adding segments invokes this automatically, but if the segment count is known
 * performance can be improved.
 * @param {number} newSize New size.
 */
player.dash.SegmentIndex.prototype.resize = function(newSize) {
  // Always add a bit extra to avoid expensive resizes when capping
  newSize += 2;

  var offsets = this.offsets_;
  this.offsets_ = new Float64Array(newSize + 1);
  var startTimes = this.startTimes_;
  this.startTimes_ = new Float32Array(newSize + 1);
  for (var i = 0; i < this.count_ + 1; i++) {
    this.offsets_[i] = offsets[i];
    this.startTimes_[i] = startTimes[i];
  }
};


/**
 * Check whether we need to expand, do it if we do.
 * @private
 */
player.dash.SegmentIndex.prototype.checkExpand_ = function() {
  if (this.offsets_.length < this.count_ + 1) {
    this.resize(this.offsets_.length * 2);
  }
};


/**
 * Indicates that this segment index will be grown in "capped" mode, where a
 * segment's extents are communicated explicitly.
 * @param {number} offset Byte offset of first media segment.
 * @param {number} startTime Start time of first media segment.
 */
player.dash.SegmentIndex.prototype.setFirstSegmentStart =
    function(offset, startTime) {
  this.offsets_[0] = offset;
  this.startTimes_[0] = startTime;
  this.isCapped_ = true;
};


/**
 * Grows the index in in "capped" mode by providing a new extent.
 * @param {number} length Byte length of new media segment.
 * @param {number} duration Time length of new media segment.
 */
player.dash.SegmentIndex.prototype.addSegmentBySize =
    function(length, duration) {
  this.count_++;
  this.checkExpand_();
  this.offsets_[this.count_] = this.offsets_[this.count_ - 1] + length;
  this.startTimes_[this.count_] = this.startTimes_[this.count_ - 1] + duration;
};


/**
 * Adds a new segment (when not in "capped" mode) by specifying start info.
 * @param {number} offset Byte offset of new media segment.
 * @param {number} startTime Start time of new media segment.
 */
player.dash.SegmentIndex.prototype.addSegmentByStart =
    function(offset, startTime) {
  this.checkExpand_();
  this.offsets_[this.count_] = offset;
  this.startTimes_[this.count_] = startTime;
  this.count_++;
};


/**
 * Convert an uncapped index (which doesn't know the extent of the last segment)
 * to a capped one by providing overall file details. This is likely to be
 * slightly wrong, as the last segment will also catch metadata at the end of
 * the file, but the effects are hopefully not calamitous since there's another
 * parser underneath us.
 * @param {number} duration Duration of the file.
 * @param {number} length Byte length of the file.
 */
player.dash.SegmentIndex.prototype.cap = function(duration, length) {
  this.checkExpand_();
  this.isCapped_ = true;
  this.startTimes_[this.count_] = duration;
  this.offsets_[this.count_] = length;
};


/**
 * Turn an ArrayBuffer (that is a sidx atom) into a segment index.
 * It is assumed that the sidx atom starts at byte 0.
 *
 * @param {ArrayBuffer} ab The ArrayBuffer of a sidx atom.
 * @param {number} sidxStart The offset of the start of the sidx atom.
 * @see http://www.iso.org/iso/catalogue_detail.htm?csnumber=61988
 *     (ISO/IEC 14496-12:2012 section 8.16.3)
 */
player.dash.SegmentIndex.prototype.parseSidx = function(ab, sidxStart) {
  var d = new DataView(ab);
  var pos = 0;

  var sidxEnd = d.getUint32(0, false);

  var version = d.getUint8(pos + 8);
  pos += 12;

  // Skip reference_ID(32)

  var timescale = d.getUint32(pos + 4, false);
  pos += 8;

  var earliestPts;
  var firstOffset;
  if (version == 0) {
    earliestPts = d.getUint32(pos, false);
    firstOffset = d.getUint32(pos + 4, false);
    pos += 8;
  } else {
    earliestPts =
        (d.getUint32(pos, false) << 32) + d.getUint32(pos + 4, false);
    firstOffset =
        (d.getUint32(pos + 8, false) << 32) + d.getUint32(pos + 12, false);
    pos += 16;
  }

  firstOffset += sidxEnd + sidxStart;
  this.setFirstSegmentStart(firstOffset, earliestPts);

  // Skip reserved(16)
  var referenceCount = d.getUint16(pos + 2, false);
  pos += 4;

  for (var i = 0; i < referenceCount; i++) {
    var length = d.getUint32(pos, false);
    var duration = d.getUint32(pos + 4, false);
    pos += 12;
    this.addSegmentBySize(length, duration / timescale);
  }
};


/**
 * Parse a WebM 'Cues' element into a SegmentIndex.
 *
 * TODO(strobe): Unit test.
 *
 * @param {ArrayBuffer} initData The ArrayBuffer containing the WebM
 *     initialization segment (for VOD, a slice from the front of the file,
 *     containing at least one truncated element).
 * @param {ArrayBuffer} cuesData The ArrayBuffer containing the Cues element.
 * @see {http://wiki.webmproject.org/adaptive-streaming/webm-dash-specification}
 */
player.dash.SegmentIndex.prototype.parseWebM = function(initData, cuesData) {
  // First, extract the needed parameters from the init segment.
  var parser = new player.utils.WebMElemParser_(new DataView(initData));

  if (parser.readId() != 0x1a45dfa3) {  // 'EBML' element
    yt.debug.severe('SegmentIndex', 'Invalid EBML ID');
    return;
  }
  // Skip the EBML header, which must come first.
  parser.skipElement();

  if (parser.readId() != 0x18538067) {  // 'Segment' element
    yt.debug.severe('SegmentIndex', 'Invalid Segment ID');
    return;
  }

  // Grab the segment size to cap the last segment in the file.
  var segmentSize = parser.peekSize();

  // Discard the segment parser, we're only interested in its contents now
  parser = parser.readSubElement();

  // Capture the offset to the first byte of the contents of the segment to use
  // as the relative base for 'Cues' elements.
  // TODO(strobe): This assumes single-segment media streams, which may not be
  // true for live, depending.
  var segmentOffset = parser.getCurrentOffset();

  var id = parser.readId();
  while (id != 0x1549a966) {  // 'Info' element
    parser.skipElement();
    id = parser.readId();
  }

  // Again discard the outer element to get at its contents
  parser = parser.readSubElement();

  var timescaleNum = 1000000;  // Default timescale numerator
  var timescaleDen = 1000000000;  // Default timescale denominator
  var duration = 0;

  while (!parser.atEos()) {
    id = parser.readId();
    if (id == 0x2ad7b1) {  // 'TimecodeScale' element
      timescaleNum = parser.readInt();
    } else if (id == 0x2ad7b2) {  // 'TimecodeScaleDenominator' element
      timescaleDen = parser.readInt();
    } else if (id == 0x4489) {  // 'Duration' element
      duration = parser.readFloat();
    } else {
      parser.skipElement();
    }
  }

  var timebase = timescaleNum / timescaleDen;
  duration *= timebase;

  // Done with initialization segment. On to the cues.
  parser = new player.utils.WebMElemParser_(new DataView(cuesData));
  if (parser.readId() != 0x1c53bb6b) {  // 'Cues' element
    yt.debug.severe('SegmentIndex', 'Invalid Cues ID');
    return;
  }

  // As before, we only care about the 'Cues' element contents
  parser = parser.readSubElement();

  while (!parser.atEos()) {
    id = parser.readId();
    if (id == 0xbb) {  // 'CuePoint' element
      var subelem = parser.readSubElement();
      var offAndTime = player.dash.SegmentIndex.readWebMCuePoint_(
          subelem, timebase, segmentOffset);
      this.addSegmentByStart(offAndTime[0], offAndTime[1]);
    } else {
      parser.skipElement();
    }
  }
  this.cap(duration, segmentSize + segmentOffset);
};


/**
 * Parse a WebM 'CuePoint' element into a SegmentReference.
 *
 * @param {yt.player.utils.WebMElemParser_} parser The parser.
 * @param {number} timebase The timebase.
 * @param {number} offset The offset in bytes from the start of the cluster.
 * @return {Array.<number>} A 2-tuple (first byte offset, start time), or
 *     null if there was an error.
 * @private
 */
player.dash.SegmentIndex.readWebMCuePoint_ = function(
    parser, timebase, offset) {
  // Assumed structure: 'CueTime' followed by one 'CueTrackPositions'. This is
  // not intended to be a generalized parser, and will not handle muxed streams.
  if (parser.readId() != 0xb3) {  // 'CueTime' element
    return null;
  }
  var time = parser.readInt() * timebase;

  if (parser.readId() != 0xb7) {  // 'CueTrackPositions' element
    return null;
  }
  // In familiar style, discard the outer parser.
  parser = parser.readSubElement();

  var clusterPos = offset;
  while (!parser.atEos()) {
    var id = parser.readId();
    if (id == 0xf1) {  // 'CueClusterPosition' element
      clusterPos = parser.readInt() + offset;
    } else {
      parser.skipElement();
    }
  }
  return [clusterPos, time];
};



/**
 * Helper class for WebM parsing. Takes a DataView containing the elements to
 * be parsed.
 *
 * @param {DataView} elemData The element data view.
 * @param {number=} opt_start The byte offset of the earliest stream, relative
 *     to an (unspecified) reference point. The current position relative to
 *     this start point can be queried on the element, and the information will
 *     be passed to subelements.
 *
 * @constructor
 * @private
 */
player.utils.WebMElemParser_ = function(elemData, opt_start) {
  /**
   * The element data being processed.
   *
   * @type {DataView}
   * @private
   */
  this.elemData_ = elemData;


  /**
   * The offset of the next byte in the current element data view.
   *
   * @type {number}
   * @private
   */
  this.pos_ = 0;

  /**
   * The start position of the first byte in the data view.
   *
   * @type {number}
   * @private
   */
  this.start_ = opt_start || 0;
};


/**
 * Test if there is data remaining in the stream.
 *
 * @return {boolean} True if data remains.
 */
player.utils.WebMElemParser_.prototype.atEos = function() {
  return this.pos_ >= this.elemData_.byteLength;
};


/**
 * Read an element identifier from the stream, advancing the read pointer.
 *
 * Note that void elements will automatically be skipped.
 *
 * @return {number} The element ID.
 */
player.utils.WebMElemParser_.prototype.readId = function() {
  var id = this.readCodedInt_(false);
  while (id == 0xec) {
    this.skipElement();
    id = this.readCodedInt_(false);
  }
  return id;
};


/**
 * Read a subelement from the stream. Returns a new parser which contains the
 * subelement's data, and advances the position of the current parser to the
 * next element at the current level.
 *
 * @return {yt.player.utils.WebMElemParser_} The new parser.
 */
player.utils.WebMElemParser_.prototype.readSubElement = function() {
  var size = this.readCodedInt_(true);
  var subData = new DataView(this.elemData_.buffer.slice(
      this.elemData_.byteOffset + this.pos_,
      this.elemData_.byteOffset + this.pos_ + size));
  var subStart = this.start_ + this.pos_;
  var parser = new player.utils.WebMElemParser_(subData, subStart);
  this.pos_ += size;
  return parser;
};


/**
 * Peeks at the size of the next element in the stream.
 * @return {number} The size value.
 */
player.utils.WebMElemParser_.prototype.peekSize = function() {
  var pos = this.pos_;
  var value = this.readCodedInt_(true);
  this.pos_ = pos;
  return value;
};


/**
 * Read an integer element from the stream.
 *
 * @return {number} The integer value.
 */
player.utils.WebMElemParser_.prototype.readInt = function() {
  var size = this.readCodedInt_(true);
  var value = this.readSizedInt_(size);
  return value;
};


/**
 * Read a floating-point element from the stream.
 *
 * @return {number} The integer value.
 */
player.utils.WebMElemParser_.prototype.readFloat = function() {
  var size = this.readCodedInt_(true);
  var value = this.readSizedFloat_(size);
  return value;
};


/**
 * Advance the stream past the current element.
 */
player.utils.WebMElemParser_.prototype.skipElement = function() {
  var size = this.readCodedInt_(true);
  this.pos_ += size;
};


/**
 * Get the position of the current offset with respect to the start offset
 * supplied to the top-level element at creation.
 *
 * @return {number} The offset.
 */
player.utils.WebMElemParser_.prototype.getCurrentOffset = function() {
  return this.start_ + this.pos_;
};


/**
 * Read a WebM-encoded integer. This encoding is used to represent element IDs,
 * element data sizes, and unsigned integers. Signed integers are not yet
 * supported.
 *
 * @param {boolean} useMask Whether to mask out the EBML Length Descriptor.
 * @return {number} The value.
 * @private
 * @see http://www.matroska.org/technical/specs/index.html
 */
player.utils.WebMElemParser_.prototype.readCodedInt_ = function(useMask) {
  var value = this.readByte_();

  if (value == 0x01) {
    // We run into precision problems in this case, handle it separately.
    value = 0;
    for (var i = 0; i < 7; i++) {
      value = (value * 256) + this.readByte_();
    }
    return value;
  }

  var mask = 128;
  for (var i = 0; i < 6 && mask > value; i++) {
    value = (value * 256) + this.readByte_();
    mask *= 128;
  }

  if (useMask) {
    // Can't use bitwise operations because this value can exceed int31.
    return value - mask;
  } else {
    return value;
  }
};


/**
 * Read a raw integer with an arbitrary number of bytes.
 *
 * @param {number} size Number of bytes to read.
 * @return {number} The value.
 * @private
 */
player.utils.WebMElemParser_.prototype.readSizedInt_ = function(size) {
  var value = this.readByte_();
  for (var i = 1; i < size; i++) {
    value = (value << 8) + this.readByte_();
  }
  return value;
};


/**
 * Read a float.
 *
 * @param {number} size Number of bytes (4 or 8).
 * @return {number} The value.
 * @private
 */
player.utils.WebMElemParser_.prototype.readSizedFloat_ = function(size) {
  var value = 0;
  if (size == 4) {
    value = this.elemData_.getFloat32(this.pos_);
  } else if (size == 8) {
    value = this.elemData_.getFloat64(this.pos_);
  }
  this.pos_ += size;
  return value;
};


/**
 * Read a single byte from the stream and advance the stream position.
 *
 * @return {number} The byte.
 * @private
 */
player.utils.WebMElemParser_.prototype.readByte_ = function() {
  return this.elemData_.getUint8(this.pos_++);
};
