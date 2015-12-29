const createTextTracksIfNecessary = function(sourceBuffer, mediaSource, segment) {
  // create an in-band caption track if one is present in the segment
  if (segment.captions &&
      segment.captions.length &&
      !sourceBuffer.inbandTextTrack_) {
    sourceBuffer.inbandTextTrack_ = mediaSource.player_.addTextTrack('captions');
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
