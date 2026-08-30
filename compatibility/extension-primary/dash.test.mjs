import test from "node:test";
import assert from "node:assert/strict";
import {
  DASH_ERROR_CODES,
  DASH_LIMITS,
  DashParseError,
  parseDashByteRange,
  parseDashManifest,
  resolveDashUrl,
} from "./dash.js";

const manifestUrl = "https://media.example/manifests/movie.mpd";

function onlyRepresentation(plan, periodIndex = 0, adaptationIndex = 0, representationIndex = 0) {
  return plan.periods[periodIndex].adaptationSets[adaptationIndex].representations[representationIndex];
}

test("expands bounded Number templates and preserves representation selection metadata", () => {
  const plan = parseDashManifest(`<?xml version="1.0"?>
    <MPD type="static" mediaPresentationDuration="PT6S">
      <Period id="main" start="PT0S" duration="PT6S">
        <AdaptationSet id="v" contentType="video" mimeType="video/mp4" codecs="avc1.640028" lang="en">
          <Representation id="v720" bandwidth="1500000" width="1280" height="720">
            <SegmentTemplate timescale="1" duration="2" startNumber="5"
              initialization="init-$RepresentationID$.mp4" media="v-$Number%02d$.m4s" />
          </Representation>
        </AdaptationSet>
      </Period>
    </MPD>`, manifestUrl);

  assert.equal(plan.type, "static");
  assert.equal(plan.duration, 6);
  const representation = onlyRepresentation(plan);
  assert.deepEqual({
    id: representation.id,
    kind: representation.kind,
    mimeType: representation.mimeType,
    codecs: representation.codecs,
    bandwidth: representation.bandwidth,
    width: representation.width,
    height: representation.height,
    language: representation.language,
  }, {
    id: "v720",
    kind: "video",
    mimeType: "video/mp4",
    codecs: "avc1.640028",
    bandwidth: 1500000,
    width: 1280,
    height: 720,
    language: "en",
  });
  assert.equal(representation.initialization.url, "https://media.example/manifests/init-v720.mp4");
  assert.deepEqual(representation.segments.map((segment) => segment.url), [
    "https://media.example/manifests/v-05.m4s",
    "https://media.example/manifests/v-06.m4s",
    "https://media.example/manifests/v-07.m4s",
  ]);
  assert.deepEqual(representation.segments.map((segment) => segment.number), [5, 6, 7]);
  assert.deepEqual(representation.segments.map((segment) => segment.duration), [2, 2, 2]);
});

test("inherits BaseURL at every MPD level and expands Time templates with bounded timeline repeats", () => {
  const plan = parseDashManifest(`<MPD mediaPresentationDuration="PT6S">
    <BaseURL>https://cdn.example/video/</BaseURL>
    <Period duration="PT6S">
      <BaseURL>season-1/</BaseURL>
      <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f">
        <BaseURL>video/</BaseURL>
        <Representation id="cam" bandwidth="900000">
          <BaseURL>camera/</BaseURL>
          <SegmentTemplate timescale="10" presentationTimeOffset="5"
            initialization="init-$RepresentationID$.mp4" media="chunk-$Time$.m4s">
            <SegmentTimeline>
              <S t="5" d="20" r="1" />
              <S t="50" d="10" />
            </SegmentTimeline>
          </SegmentTemplate>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`, manifestUrl);

  const representation = onlyRepresentation(plan);
  assert.equal(representation.initialization.url, "https://cdn.example/video/season-1/video/camera/init-cam.mp4");
  assert.deepEqual(representation.segments.map((segment) => segment.url), [
    "https://cdn.example/video/season-1/video/camera/chunk-5.m4s",
    "https://cdn.example/video/season-1/video/camera/chunk-25.m4s",
    "https://cdn.example/video/season-1/video/camera/chunk-50.m4s",
  ]);
  assert.deepEqual(representation.segments.map((segment) => segment.time), [5, 25, 50]);
  assert.deepEqual(representation.segments.map((segment) => segment.duration), [2, 2, 1]);
});

test("derives static period and manifest duration from a finite timeline", () => {
  const plan = parseDashManifest(`<MPD>
    <Period>
      <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f">
        <Representation id="derived">
          <SegmentTemplate timescale="10" media="segment-$Time$.m4s">
            <SegmentTimeline><S t="0" d="10" r="2" /></SegmentTimeline>
          </SegmentTemplate>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`, manifestUrl);

  assert.equal(plan.periods[0].duration, 3);
  assert.equal(plan.duration, 3);
  assert.deepEqual(onlyRepresentation(plan).segments.map((segment) => segment.url), [
    "https://media.example/manifests/segment-0.m4s",
    "https://media.example/manifests/segment-10.m4s",
    "https://media.example/manifests/segment-20.m4s",
  ]);
});

test("normalizes SegmentList URLs in order and carries initialization and media byte ranges", () => {
  const plan = parseDashManifest(`<MPD>
    <Period duration="PT8S">
      <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2" lang="ko">
        <Representation id="a1" bandwidth="128000">
          <BaseURL>https://media.example/audio/track.mp4</BaseURL>
          <SegmentList timescale="1" duration="4">
            <Initialization sourceURL="init.mp4" range="0-99" />
            <SegmentURL media="audio-1.m4s" mediaRange="100-199" />
            <SegmentURL media="audio-2.m4s" mediaRange="200-299" />
          </SegmentList>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`, manifestUrl);

  const representation = onlyRepresentation(plan);
  assert.equal(representation.kind, "audio");
  assert.equal(representation.language, "ko");
  assert.deepEqual(representation.initialization, {
    url: "https://media.example/audio/init.mp4",
    range: { offset: 0, length: 100 },
  });
  assert.deepEqual(representation.segments, [
    {
      url: "https://media.example/audio/audio-1.m4s",
      range: { offset: 100, length: 100 },
      number: 1,
      time: 0,
      duration: 4,
    },
    {
      url: "https://media.example/audio/audio-2.m4s",
      range: { offset: 200, length: 100 },
      number: 2,
      time: 4,
      duration: 4,
    },
  ]);
});

test("normalizes SegmentBase initialization and index range requests without fetching or parsing the index", () => {
  const plan = parseDashManifest(`<MPD>
    <Period>
      <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f">
        <Representation id="base" bandwidth="500000">
          <BaseURL>https://media.example/files/movie.mp4</BaseURL>
          <SegmentBase indexRange="100-199">
            <Initialization range="0-99" />
          </SegmentBase>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`, manifestUrl);

  const representation = onlyRepresentation(plan);
  assert.deepEqual(representation.initialization, {
    url: "https://media.example/files/movie.mp4",
    range: { offset: 0, length: 100 },
  });
  assert.deepEqual(representation.index, {
    url: "https://media.example/files/movie.mp4",
    range: { offset: 100, length: 100 },
  });
  assert.deepEqual(representation.segments, []);
});

test("rejects malformed, dynamic, unsafe, traversing, excessive, and unbounded MPDs with stable codes", () => {
  const cases = [
    ["malformed XML", `<MPD><Period></MPD>`, DASH_ERROR_CODES.INVALID_XML],
    ["dynamic MPD", `<MPD type="dynamic"><Period /></MPD>`, DASH_ERROR_CODES.DYNAMIC_MPD],
    ["CENC protected MPD", `<MPD><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" /><Representation><SegmentTemplate duration="1" media="seg-$Number$.m4s" /></Representation></AdaptationSet></Period></MPD>`, DASH_ERROR_CODES.DRM_PROTECTED],
    ["unsafe BaseURL scheme", `<MPD><BaseURL>data:text/plain,unsafe</BaseURL><Period><AdaptationSet contentType="video"><Representation id="v" /></AdaptationSet></Period></MPD>`, DASH_ERROR_CODES.UNSAFE_SCHEME],
    ["parent traversal", `<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation><SegmentTemplate duration="1" media="../seg-$Number$.m4s" /></Representation></AdaptationSet></Period></MPD>`, DASH_ERROR_CODES.PATH_TRAVERSAL],
    ["unbounded duration template", `<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation><SegmentTemplate duration="1" media="seg-$Number$.m4s" /></Representation></AdaptationSet></Period></MPD>`, DASH_ERROR_CODES.UNBOUNDED_TIMELINE],
  ];
  for (const [label, text, code] of cases) {
    assert.throws(() => parseDashManifest(text, manifestUrl), (error) => {
      assert.ok(error instanceof DashParseError, label);
      return error.code === code;
    }, label);
  }

  const tooManySegments = Array.from({ length: DASH_LIMITS.maxSegmentsPerRepresentation + 1 }, (_, index) => `<SegmentURL media="${index}.m4s" />`).join("");
  assert.throws(() => parseDashManifest(`<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation><SegmentList>${tooManySegments}</SegmentList></Representation></AdaptationSet></Period></MPD>`, manifestUrl), (error) => error.code === DASH_ERROR_CODES.LIMIT_EXCEEDED);
});

test("rejects an unbounded negative timeline repeat while accepting the explicit range grammar", () => {
  assert.deepEqual(parseDashByteRange("720-999"), { offset: 720, length: 280 });
  assert.throws(() => parseDashByteRange("100-99"), (error) => error.code === DASH_ERROR_CODES.INVALID_RANGE);
  assert.throws(() => parseDashManifest(`<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation><SegmentTemplate timescale="1" media="seg-$Time$.m4s"><SegmentTimeline><S t="0" d="2" r="-1" /></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`, manifestUrl), (error) => error.code === DASH_ERROR_CODES.UNBOUNDED_TIMELINE);
});

test("URL helper stays HTTP(S)-only and rejects ambiguous traversal before URL normalization", () => {
  assert.equal(resolveDashUrl("chunk.m4s", manifestUrl), "https://media.example/manifests/chunk.m4s");
  assert.throws(() => resolveDashUrl("javascript:alert(1)", manifestUrl), (error) => error.code === DASH_ERROR_CODES.UNSAFE_SCHEME);
  assert.throws(() => resolveDashUrl("%2e%2e/secret.m4s", manifestUrl), (error) => error.code === DASH_ERROR_CODES.PATH_TRAVERSAL);
});
