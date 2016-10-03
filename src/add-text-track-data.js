/**
 * @file add-text-track-data.js
 */
import window from 'global/window';
import videojs from 'video.js';
/**
 * Define properties on a cue for backwards compatability,
 * but warn the user that the way that they are using it
 * is depricated and will be removed at a later date.
 *
 * @param {Cue} cue the cue to add the properties on
 * @private
 */
const deprecateOldCue = function(cue) {
  Object.defineProperties(cue.frame, {
    id: {
      get() {
        videojs.log.warn(
          'cue.frame.id is deprecated. Use cue.value.key instead.'
        );
        return cue.value.key;
      }
    },
    value: {
      get() {
        videojs.log.warn(
          'cue.frame.value is deprecated. Use cue.value.data instead.'
        );
        return cue.value.data;
      }
    },
    privateData: {
      get() {
        videojs.log.warn(
          'cue.frame.privateData is deprecated. Use cue.value.data instead.'
        );
        return cue.value.data;
      }
    }
  });
};

const durationOfVideo = function(duration) {
  let dur;

  if (isNaN(duration) || Math.abs(duration) === Infinity) {
    dur = Number.MAX_VALUE;
  } else {
    dur = duration;
  }
  return dur;
};
/**
 * Add text track data to a source handler given the captions and
 * metadata from the buffer.
 *
 * @param {Object} sourceHandler the flash or virtual source buffer
 * @param {Array} captionArray an array of caption data
 * @param {Array} cue an array of meta data
 * @private
 */
const addTextTrackData = function(sourceHandler, captionArray, metadataArray) {
  let Cue = window.WebKitDataCue || window.VTTCue;

  if (captionArray) {
    captionArray.forEach(function(caption) {
      this.inbandTextTrack_.addCue(
        new Cue(
          caption.startTime + this.timestampOffset,
          caption.endTime + this.timestampOffset,
          caption.text
        ));
    }, sourceHandler);
  }

  if (metadataArray) {
    let videoDuration = durationOfVideo(sourceHandler.mediaSource_.duration);

    metadataArray.forEach(function(metadata) {
      let time = metadata.cueTime + this.timestampOffset;

      metadata.frames.forEach(function(frame) {
        let cue = new Cue(
          time,
          time,
          frame.value || frame.url || frame.data || '');

        cue.frame = frame;
        cue.value = frame;
        deprecateOldCue(cue);

        this.metadataTrack_.addCue(cue);
      }, this);
    }, sourceHandler);

    /** Updating the metadeta cues so that
     * the endTime of each cue is the startTime of the next cue
     * the endTime of last cue is the duration of the video
     */
    if (sourceHandler.metadataTrack_ && sourceHandler.metadataTrack_.cues) {
      let cues = sourceHandler.metadataTrack_.cues;
      let cuesArray = [];

      for (let j = 0; j < cues.length; j++) {
        cuesArray.push(cues[j]);
      }
      cuesArray.sort((first, second) => first.startTime - second.startTime);

      for (let i = 0; i < cuesArray.length - 1; i++) {
        if (cuesArray[i].endTime !== cuesArray[i + 1].startTime) {
          cuesArray[i].endTime = cuesArray[i + 1].startTime;
        }
      }
      cuesArray[cuesArray.length - 1].endTime = videoDuration;
    }
  }
};

export default {
  addTextTrackData,
  durationOfVideo
};
