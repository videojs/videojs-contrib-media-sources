/**
 * @file create-text-tracks-if-necessary.js
 */

/**
 * Create text tracks on video.js if they exist on a segment.
 *
 * @param {Object} sourceBuffer the VSB or FSB
 * @param {Object} mediaSource the HTML or Flash media source
 * @param {Object} segment the segment that may contain the text track
 * @private
 */
const createTextTracksIfNecessary = function(sourceBuffer, mediaSource, segment) {
  // create an in-band caption track if one is present in the segment
  if (segment.captions &&
      segment.captions.length &&
      !sourceBuffer.inbandTextTrack_) {
    sourceBuffer.inbandTextTrack_ = mediaSource.player_.addTextTrack('captions', 'cc1');
  }

  if (segment.metadata &&
      segment.metadata.length &&
      !sourceBuffer.metadataTrack_) {
    sourceBuffer.metadataTrack_ =
      mediaSource.player_.addTextTrack('metadata', 'Timed Metadata');
    sourceBuffer.metadataTrack_.inBandMetadataTrackDispatchType =
      segment.metadata.dispatchType;
  }
};

export default createTextTracksIfNecessary;
