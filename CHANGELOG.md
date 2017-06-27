CHANGELOG
=========

--------------------
## 4.4.5 (2017-06-27)
* update mux.js to v4.1.5 [#150](https://github.com/videojs/videojs-contrib-media-sources/pull/150)
  * Only flush PES packets from TS parsing front end when they are complete
    * Complete is defined as any time PES_packet_length matches the data’s length OR is a video packets
    * Works around an issue with incomplete packets getting sent down the pipeline when the source has audio PES packets split between segments

--------------------
## 4.4.5 (2017-05-16)
* update mux.js to 4.1.4 [#144](https://github.com/videojs/videojs-contrib-media-sources/pull/144)
  * ts probe searches packets for first it can successfully parse
* Fixed an issue that could cause updateend events to fire more than once per append or remove under very specific conditions on firefox [#142](https://github.com/videojs/videojs-contrib-media-sources/pull/142)
  * wrapping source buffer objects so that we can handle the `updating` state ourselves

--------------------
## 4.4.4 (2017-04-24)
* update mux.js to 4.1.3 [#141](https://github.com/videojs/videojs-contrib-media-sources/pull/141)

--------------------
## 4.4.3 (2017-04-10)
* update mux.js to 4.1.2 [#139](https://github.com/videojs/videojs-contrib-media-sources/pull/139)

--------------------
## 4.4.2 (2017-03-03)
* update mux.js to v4.1.1 [#138](https://github.com/videojs/videojs-contrib-media-sources/pull/138)
  * Fix silence insertion to not insert extra frames when audio is offset [#143](https://github.com/videojs/mux.js/pull/143)
