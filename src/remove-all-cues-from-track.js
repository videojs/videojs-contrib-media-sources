/**
 * @file remove-all-cues-from-track.js
 */

/**
 * Remove all cues from a track on video.js.
 *
 * @param {Object} track the text track to remove the cues from
 * @private
 */
const removeAllCuesFromTrack = function(track) {
  if (!track) {
    return;
  }

  if (!track.cues) {
    return;
  }

  track.cues.forEach(function(cue) {
    track.removeCue(cue);
  });
};

export default removeAllCuesFromTrack;
