/**
 * @file flash-constants.js
 */
/**
 * The maximum size in bytes for append operations to the video.js
 * SWF. Calling through to Flash blocks and can be expensive so
 * tuning this parameter may improve playback on slower
 * systems. There are two factors to consider:
 * - Each interaction with the SWF must be quick or you risk dropping
 * video frames. To maintain 60fps for the rest of the page, each append
 * must not  take longer than 16ms. Given the likelihood that the page
 * will be executing more javascript than just playback, you probably
 * want to aim for less than 8ms. We aim for just 4ms.
 * - Bigger appends significantly increase throughput. The total number of
 * bytes over time delivered to the SWF must exceed the video bitrate or
 * playback will stall.
 *
 * We adaptively tune the size of appends to give the best throughput
 * possible given the performance of the system. To do that we try to append
 * as much as possible in TIME_PER_TICK and while tuning the size of appends
 * dynamically so that we only append about 4-times in that 4ms span.
 *
 * The reason we try to keep the number of appends around four is due to
 * externalities such as Flash load and garbage collection that are highly
 * variable and having 4 iterations allows us to exit the loop early if
 * an iteration takes longer than expected.
 *
 * @private
 */
const flashConstants = {
  TIME_BETWEEN_TICKS: Math.floor(1000 / 480),
  TIME_PER_TICK: Math.floor(1000 / 240),
  // 1kb
  BYTES_PER_CHUNK: 1 * 1024,
  MIN_CHUNK: 1024,
  MAX_CHUNK: 1024 * 1024
};

export default flashConstants;
