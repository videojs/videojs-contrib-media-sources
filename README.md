# videojs-media-sources

A [Media Source Extensions](https://dvcs.w3.org/hg/html-media/raw-file/tip/media-source/media-source.html) plugin for video.js.

Media Source Extensions (MSE) is a W3C draft specification that makes it possible to feed data directly to a video element.
MSE allows video developers to build functionality like adaptive streaming directly in javascript.

## Getting Started

The plugin exposes a MediaSource shim that can be used to feed dynamic content to a video element.
On browsers that natively support Media Source Extensions, the HTML implementation will be used.
If you're running in an environment without MSE, a Flash-backed polyfill will be used.
Currently, the Flash polyfill only supports video content encoded in the FLV file format.
For information on how FLVs are structured, Adobe hosts the [latest version of the spec](http://www.adobe.com/devnet/f4v.html) on their site.

The Flash polyfill attempts to balance throughput to the FLV with end-user responsiveness by asynchronously feeding bytes to the SWF at a fixed rate.
By default, that rate is capped at 4MB/s.
If you'd like to play higher bitrate content, you can adjust that setting:

```javascript
// 8MB/s at 60fps
videojs.MediaSource.MAX_APPEND_SIZE = Math.ceil((8 * 1024 * 1024) / 60);
```
Setting the `MAX_APPEND_SIZE` too high may lead to dropped frames during playback on slower computers.

Check out an example of the plugin in use in [example.html](example.html).

## Release History

 * 0.3.0: Delegate SourceBuffer.abort() calls to the SWF
 * 0.2.0: Improve interactivity by batching communication with Flash.
 * 0.1.0: Initial release

## License

See [LICENSE-APACHE2](LICENSE-APACHE2).
