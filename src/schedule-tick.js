import FlashMediaSource from './flash-media-source';

const scheduleTick = function(func) {
  // Chrome doesn't invoke requestAnimationFrame callbacks
  // in background tabs, so use setTimeout.
  window.setTimeout(func, FlashMediaSource.TIME_BETWEEN_TICKS);
};

export default scheduleTick;
