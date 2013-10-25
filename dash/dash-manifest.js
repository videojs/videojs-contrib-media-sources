"use strict";
/* Copyright 2012 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * 0.2-194-g64a6e17
 */

/**
 * @fileoverview MPEG-DASH manifest parser
 * @author strobe@google.com (Steven Robertson)
 */
(function() {

function id(x) {
  return x;
}

// --- DASH manifest parsing ---

function parseDuration(dur_str) {
  // Unsupported: date part of ISO 8601 durations
  var re = /PT(([0-9]*)H)?(([0-9]*)M)?(([0-9.]*)S)?/;
  var match = re.exec(dur_str);
  if (!match) return parseFloat(dur_str);
  return (parseFloat(match[2] || 0) * 3600 +
          parseFloat(match[4] || 0) * 60 +
          parseFloat(match[6] || 0));
}

function parseChildElements(node_name, parse_func, xml) {
  var result = [];
  if (xml == null) return result;
  for (var child = xml.firstElementChild; child != null;
       child = child.nextElementSibling) {
    if (child.nodeName == node_name) {
      result.push(parse_func(child));
    }
  }
  return result;
}

function parseChildElement(node_name, parse_func, xml) {
  return parseChildElements(node_name, parse_func, xml)[0] || null;
}

function parseAttributes(attr_map, xml, result) {
  result = result || {};
  for (var k in attr_map) {
    if (xml.attributes.getNamedItem(k) != null)
      result[k] = attr_map[k](xml.attributes[k].value);
  }
  return result;
}

function parseFrameRate(str) {
  var match = /([0-9]+)(\/([0-9]+))?/.exec(str);
  if (!match) return 1;
  if (!match[3]) return parseFloat(match[1]);
  return parseFloat(match[1]) / (parseFloat(match[3]) || 1);
}

function parseByteRange(str) {
  var match = /([0-9]+)-([0-9]+)/.exec(str);
  if (!match) return null;
  var start = parseInt(match[1]), end = parseInt(match[2]);
  return { start: start, end: end, length: end - start + 1 };
}

var SegmentURLAttributes =
    { media: id
    , mediaRange: parseByteRange
    , index: id
    , indexRange: parseByteRange
    };

function parseSegmentURL(xml) {
  return parseAttributes(SegmentURLAttributes, xml);
}

function parseBaseURL(xml) {
  // Unsupported: service locations
  return xml.textContent;
}

function parseInitialization(xml) {
  // MP4 specific
  return parseByteRange(xml.attributes.range.value);
}

// Includes MultipleSegmentBaseAttributes.
var SegmentBaseAttributes =
    { timescale: parseInt
    , duration: parseInt
    , indexRange: parseByteRange
    , presentationTimeOffset: parseInt
    , startNumber: parseInt
    };

function parseSegmentBase(xml) {
  // Unsupported: @indexRangeExact, RepresentationIndex, SegmentTimeline,
  // BitstreamSwitching
  var result = parseAttributes(SegmentBaseAttributes, xml);
  result.initialization = parseChildElement(
      'Initialization', parseInitialization, xml);
  return result;
}

function parseSegmentList(xml) {
  // Unsupported: @xlinks, @actuate, SegmentTimeline, BitstreamSwiching
  var result = parseSegmentBase(xml);
  if (result.timescale && result.duration) {
    result.durationSeconds = result.duration / result.timescale;
  } else {
    result.durationSeconds = result.duration;
  }
  result.segmentURLs = parseChildElements('SegmentURL', parseSegmentURL, xml);
  return result;
}

var parseContentProtection = function(node) {
  var schemeUri = node.attributes['schemeIdUri'];
  if (!schemeUri ||
      schemeUri.textContent != 'http://youtube.com/drm/2012/10/10') {
    // Unsupported scheme, ignore.
    return null;
  }
  var map = {};
  for (var system = node.firstElementChild; system != null;
      system = system.nextElementSibling) {
    if (system.nodeName != 'yt:SystemURL') continue;
    var flavor = system.attributes['type'].textContent;
    map[flavor] = system.textContent;
  }
  return map;
};

var RepresentationBaseAttributes =
    { id: parseInt
    , profiles: id
    , width: parseInt
    , height: parseInt
    , frameRate: parseFrameRate
    , audioSamplingRate: parseInt
    , mimeType: id
    , codecs: id
    };

function parseRepresentationBase(xml) {
  // Unsupported: @sar, @segmentProfiles, @maximumSAPPeriod, @startWithSAP,
  // @maxPlayoutRate, @codingDependency, @scanType, FramePacking,
  // AudioChannelConfiguration, ContentProtection, SegmentBase
  //
  // TODO(strobe): SegmentTemplate
  var result = parseAttributes(RepresentationBaseAttributes, xml);
  result.baseURLs = parseChildElements('BaseURL', parseBaseURL, xml);
  result.segmentBase = parseChildElement(
      'SegmentBase', parseSegmentBase, xml);
  result.segmentList = parseChildElement(
      'SegmentList', parseSegmentList, xml);
  result.contentProtection = parseChildElement(
      'ContentProtection', parseContentProtection, xml);
  return result;
}

var RepresentationAttributes =
    { bandwidth: parseInt
    , qualityRanking: parseInt
    };

function parseRepresentation(xml) {
  // Unsupported: @dependencyId, @mediaStreamStructureId, SubRepresentation,
  // SegmentTemplate
  var result = parseRepresentationBase(xml);
  parseAttributes(RepresentationAttributes, xml, result);
  return result;
}

function parseAdaptationSet(xml) {
  // Unsupported: @lang, @contentType, @par, @minBandwidth, @maxBandwidth,
  // @minWidth, @maxWidth, @minHeight, @maxHeight, @minFrameRate,
  // @maxFrameRate, @segmentAlignment, @bitstreamSwitching,
  // @subsegmentAlignment, @subsegmentStartsWithSAP, Accessibility,
  // Role, Rating, Viewpoint, ContentComponent, SegmentTemplate
  //
  // TODO(strobe): ContentComponent, SegmentTemplate
  var result = parseRepresentationBase(xml);
  result.representations = parseChildElements(
      'Representation', parseRepresentation, xml);
  return result;
}

var PeriodAttributes =
    { id: parseInt
    , start: parseDuration
    , duration: parseDuration
    };

function parsePeriod(xml) {
  // Unsupported: @href, @actuate, @bitstreamSwitching, SegmentTemplate
  var result = parseRepresentationBase(xml);
  parseAttributes(PeriodAttributes, xml, result);
  result.adaptationSets = parseChildElements(
      'AdaptationSet', parseAdaptationSet, xml);
  return result;
}

function parseMPD(xml) {
  // Unsupported: @id, @profiles, @type, @availabilityStartTime,
  // @availabilityEndTime, @minimumUpdatePeriod,
  // @minbufferTime, @timeShiftBufferDepth, @suggestedPresentationDelay,
  // @maxSegmentDuration, @maxSubsegmentDuration, ProgramInformation,
  // Location, Metrics
  var result = {};
  parseAttributes({mediaPresentationDuration: parseDuration}, xml, result);
  result.periods = parseChildElements('Period', parsePeriod, xml);
  result.baseURLs = parseChildElements('BaseURL', parseBaseURL, xml);
  return result;
}

function normalizeRepresentations(mpd, url) {
  // TODO(strobe): Deal with propagating defaults and whatnot
  mpd.manifestURL = url;
  return mpd;
}

function parseDASHManifest(text, url) {
  var parser = new DOMParser();
  var dom = parser.parseFromString(text, "text/xml");
  return normalizeRepresentations(parseMPD(dom.firstChild), url);
}
window.parseDASHManifest = parseDASHManifest;

})();
