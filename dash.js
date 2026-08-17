export const DASH_LIMITS = Object.freeze({
  manifestCharacters: 1024 * 1024,
  maxXmlNodes: 4096,
  maxXmlDepth: 64,
  maxPeriods: 64,
  maxAdaptationSets: 256,
  maxRepresentations: 1024,
  maxSegmentsPerRepresentation: 2048,
  maxTimelineEntries: 2048,
  maxTotalRequests: 16384,
  maxUrlCharacters: 4096,
  maxQueryCharacters: 2048,
});

export const DASH_ERROR_CODES = Object.freeze({
  INVALID_XML: "invalid-xml",
  INVALID_MANIFEST: "invalid-manifest",
  INVALID_URL: "invalid-url",
  UNSAFE_SCHEME: "unsafe-scheme",
  PATH_TRAVERSAL: "path-traversal",
  DYNAMIC_MPD: "dynamic-mpd",
  LIMIT_EXCEEDED: "limit-exceeded",
  UNBOUNDED_TIMELINE: "unbounded-timeline",
  INVALID_RANGE: "invalid-range",
  INVALID_TEMPLATE: "invalid-template",
  NO_MEDIA: "no-media",
  DRM_PROTECTED: "drm-protected",
});

export class DashParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DashParseError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DashParseError(code, message);
}

function localName(name) {
  const separator = name.lastIndexOf(":");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function decodeXmlEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const radix = lower.startsWith("#x") ? 16 : 10;
    const digits = lower.startsWith("#x") ? lower.slice(2) : lower.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains an invalid XML character reference.");
    }
    return String.fromCodePoint(codePoint);
  }).replace(/&(?!#x[0-9a-f]+;|#\d+;|amp;|lt;|gt;|quot;|apos;)/gi, () => {
    fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains an unknown XML entity.");
  });
}

function createXmlNode(name, attributes) {
  return { name: localName(name), attributes, children: [], text: "" };
}

function findTagEnd(text, start) {
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

function parseStartTag(body) {
  let index = 0;
  const skipSpace = () => {
    while (index < body.length && /\s/.test(body[index])) index += 1;
  };
  const readName = () => {
    const start = index;
    while (index < body.length && /[A-Za-z0-9_.:-]/.test(body[index])) index += 1;
    const value = body.slice(start, index);
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value)) {
      fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains an invalid XML name.");
    }
    return value;
  };

  skipSpace();
  const name = readName();
  const attributes = Object.create(null);
  while (true) {
    skipSpace();
    if (index >= body.length) break;
    const rawName = readName();
    const key = localName(rawName);
    if (Object.prototype.hasOwnProperty.call(attributes, key)) {
      fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains duplicate attributes.");
    }
    skipSpace();
    if (body[index] !== "=") fail(DASH_ERROR_CODES.INVALID_XML, "MPD attribute is missing its value.");
    index += 1;
    skipSpace();
    const quote = body[index];
    if (quote !== '"' && quote !== "'") {
      fail(DASH_ERROR_CODES.INVALID_XML, "MPD attribute values must be quoted.");
    }
    index += 1;
    const valueStart = index;
    while (index < body.length && body[index] !== quote) {
      if (body[index] === "<") fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains a malformed attribute.");
      index += 1;
    }
    if (index >= body.length) fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains an unterminated attribute.");
    const rawValue = body.slice(valueStart, index);
    if (rawValue.length > DASH_LIMITS.maxUrlCharacters * 2) {
      fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "MPD attribute is too large.");
    }
    attributes[key] = decodeXmlEntities(rawValue);
    index += 1;
  }
  return { name: localName(name), attributes };
}

export function parseDashXml(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > DASH_LIMITS.manifestCharacters) {
    fail(DASH_ERROR_CODES.INVALID_XML, "MPD text is missing or too large.");
  }
  const source = text.replace(/^\uFEFF/, "");
  const stack = [];
  let root = null;
  let nodeCount = 0;
  let cursor = 0;

  const appendText = (value) => {
    if (!value) return;
    const decoded = decodeXmlEntities(value);
    if (stack.length) {
      stack[stack.length - 1].text += decoded;
    } else if (/\S/.test(decoded)) {
      fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains text outside its root element.");
    }
  };

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) {
      appendText(source.slice(cursor));
      cursor = source.length;
      break;
    }
    appendText(source.slice(cursor, open));

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end < 0) fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains an unterminated comment.");
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end < 0) fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains an unterminated CDATA section.");
      if (!stack.length) fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains CDATA outside its root element.");
      stack[stack.length - 1].text += source.slice(open + 9, end);
      cursor = end + 3;
      continue;
    }
    if (/^<!DOCTYPE\b/i.test(source.slice(open))) {
      fail(DASH_ERROR_CODES.INVALID_XML, "MPD doctypes and external entities are not supported.");
    }
    if (source.startsWith("<!", open)) {
      fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains an unsupported declaration.");
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      if (end < 0) fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains an unterminated processing instruction.");
      cursor = end + 2;
      continue;
    }

    const end = findTagEnd(source, open + 1);
    if (end < 0) fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains an unterminated tag.");
    const rawBody = source.slice(open + 1, end);
    const closing = rawBody.trimStart().startsWith("/");
    if (closing) {
      const closeName = rawBody.trim().slice(1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(closeName) || !stack.length
        || stack[stack.length - 1].name !== localName(closeName)) {
        fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains mismatched closing tags.");
      }
      stack.pop();
      cursor = end + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(rawBody);
    const startBody = selfClosing ? rawBody.replace(/\/\s*$/, "") : rawBody;
    const parsed = parseStartTag(startBody);
    nodeCount += 1;
    if (nodeCount > DASH_LIMITS.maxXmlNodes) fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "MPD contains too many XML nodes.");
    if (stack.length + 1 > DASH_LIMITS.maxXmlDepth) fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "MPD XML nesting is too deep.");
    const node = createXmlNode(parsed.name, parsed.attributes);
    if (!root) {
      if (node.name !== "MPD") fail(DASH_ERROR_CODES.INVALID_MANIFEST, "MPD root element is missing.");
      root = node;
    } else if (!stack.length) {
      fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains more than one root element.");
    } else {
      stack[stack.length - 1].children.push(node);
    }
    if (!selfClosing) stack.push(node);
    cursor = end + 1;
  }

  if (!root || stack.length) fail(DASH_ERROR_CODES.INVALID_XML, "MPD contains an unclosed element.");
  return root;
}

function childNodes(node, name) {
  return node.children.filter((child) => child.name === name);
}

function firstChild(node, name) {
  return childNodes(node, name)[0] || null;
}

function textContent(node) {
  return node.children.reduce((value, child) => value + textContent(child), node.text);
}

function hasAttribute(node, name) {
  return Boolean(node && Object.prototype.hasOwnProperty.call(node.attributes, name));
}

function attribute(node, name) {
  return hasAttribute(node, name) ? node.attributes[name] : null;
}

function validateString(value, label, maxLength = DASH_LIMITS.maxUrlCharacters) {
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(DASH_ERROR_CODES.INVALID_MANIFEST, `${label} is invalid.`);
  }
  return value;
}

function optionalStringAttribute(node, name, maxLength = 256) {
  const value = attribute(node, name);
  return value === null ? null : (validateString(value, name, maxLength).trim() || null);
}

function parseInteger(value, label, { minimum = 0, required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) fail(DASH_ERROR_CODES.INVALID_MANIFEST, `${label} is required.`);
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    if (required) fail(DASH_ERROR_CODES.INVALID_MANIFEST, `${label} is required.`);
    return null;
  }
  if (!/^-?\d+$/.test(raw)) fail(DASH_ERROR_CODES.INVALID_MANIFEST, `${label} is invalid.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(DASH_ERROR_CODES.INVALID_MANIFEST, `${label} is out of range.`);
  }
  return parsed;
}

function parsePositiveInteger(value, label, fallback = 1) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  return parseInteger(value, label, { minimum: 1, required: true });
}

function parseDuration(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const match = /^P(?:(\d+(?:\.\d+)?)W|(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?)$/i.exec(raw);
  if (!match || !match.slice(1).some(Boolean)) fail(DASH_ERROR_CODES.INVALID_MANIFEST, `${label} is invalid.`);
  const weeks = Number(match[1] || 0);
  const days = Number(match[2] || 0);
  const hours = Number(match[3] || 0);
  const minutes = Number(match[4] || 0);
  const seconds = Number(match[5] || 0);
  const total = weeks * 604800 + days * 86400 + hours * 3600 + minutes * 60 + seconds;
  if (!Number.isFinite(total) || total < 0) fail(DASH_ERROR_CODES.INVALID_MANIFEST, `${label} is invalid.`);
  return total;
}

function parseRange(value, label = "byte range") {
  if (value === null || value === undefined || value === "") return null;
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(value));
  if (!match) fail(DASH_ERROR_CODES.INVALID_RANGE, `${label} is invalid.`);
  const offset = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || end < offset) {
    fail(DASH_ERROR_CODES.INVALID_RANGE, `${label} is invalid.`);
  }
  const length = end - offset + 1;
  if (!Number.isSafeInteger(length)) fail(DASH_ERROR_CODES.INVALID_RANGE, `${label} is too large.`);
  return { offset, length };
}

export function parseDashByteRange(value) {
  return parseRange(value);
}

function rawPathForReference(value) {
  const withoutQuery = String(value).split(/[?#]/, 1)[0];
  const authority = /^(?:[A-Za-z][A-Za-z\d+.-]*:)?\/\/[^/]*/.exec(withoutQuery);
  return authority ? withoutQuery.slice(authority[0].length) : withoutQuery;
}

function rejectPathTraversal(value) {
  if (value.includes("\\")) fail(DASH_ERROR_CODES.PATH_TRAVERSAL, "MPD URL paths may not contain backslashes.");
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPathForReference(value));
  } catch {
    fail(DASH_ERROR_CODES.INVALID_URL, "MPD URL contains invalid escaping.");
  }
  if (decodedPath.includes("\\") || /(?:^|\/)\.\.(?:\/|$)/.test(decodedPath)) {
    fail(DASH_ERROR_CODES.PATH_TRAVERSAL, "MPD URL paths may not contain parent traversal.");
  }
}

function safeUrl(value, baseUrl = null) {
  validateString(value, "URL");
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || /\s/.test(value)) fail(DASH_ERROR_CODES.INVALID_URL, "MPD URL contains whitespace.");
  rejectPathTraversal(value);
  let parsed;
  try {
    parsed = baseUrl === null ? new URL(value) : new URL(value, baseUrl);
  } catch {
    fail(DASH_ERROR_CODES.INVALID_URL, "MPD URL is invalid.");
  }
  if (!/^https?:$/i.test(parsed.protocol)) fail(DASH_ERROR_CODES.UNSAFE_SCHEME, "MPD URLs must use HTTP(S).");
  if (parsed.username || parsed.password || parsed.hash) fail(DASH_ERROR_CODES.INVALID_URL, "MPD URL credentials and fragments are not allowed.");
  if (parsed.href.length > DASH_LIMITS.maxUrlCharacters || parsed.search.length > DASH_LIMITS.maxQueryCharacters + 1) {
    fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "MPD URL is too large.");
  }
  return parsed.href;
}

export function resolveDashUrl(value, baseUrl = null) {
  return safeUrl(value, baseUrl);
}

function applyBaseUrl(node, parent) {
  const bases = childNodes(node, "BaseURL");
  if (!bases.length) return parent;
  const raw = textContent(bases[0]).trim();
  if (!raw) fail(DASH_ERROR_CODES.INVALID_URL, "MPD BaseURL is empty.");
  return { url: safeUrl(raw, parent.url), explicit: true };
}

function mergeDescriptor(nodes, name) {
  const attributes = Object.create(null);
  let timeline = null;
  let initialization = null;
  let segmentUrls = null;
  let representationIndex = null;
  for (const node of nodes) {
    const descriptor = firstChild(node, name);
    if (!descriptor) continue;
    Object.assign(attributes, descriptor.attributes);
    const childTimeline = firstChild(descriptor, "SegmentTimeline");
    if (childTimeline) timeline = childTimeline;
    const childInitialization = firstChild(descriptor, "Initialization");
    if (childInitialization) initialization = childInitialization;
    const childSegmentUrls = childNodes(descriptor, "SegmentURL");
    if (childSegmentUrls.length) segmentUrls = childSegmentUrls;
    const childIndex = firstChild(descriptor, "RepresentationIndex");
    if (childIndex) representationIndex = childIndex;
  }
  return { attributes, timeline, initialization, segmentUrls, representationIndex };
}

function effectiveSource(nodes) {
  let source = null;
  for (const node of nodes) {
    const present = ["SegmentTemplate", "SegmentList", "SegmentBase"]
      .filter((name) => firstChild(node, name));
    if (present.length > 1) fail(DASH_ERROR_CODES.INVALID_MANIFEST, "MPD mixes segment description types at one level.");
    if (present.length) source = present[0];
  }
  return source;
}

function formatTemplateNumber(value, format) {
  const raw = String(value);
  if (!format) return raw;
  const width = Number(format.slice(2, -1));
  if (!Number.isSafeInteger(width) || width < 1 || width > 64) {
    fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "DASH template padding is too large.");
  }
  return raw.padStart(width, "0");
}

function substituteTemplate(template, values) {
  let result = "";
  for (let index = 0; index < template.length;) {
    if (template[index] !== "$") {
      result += template[index];
      index += 1;
      continue;
    }
    if (template[index + 1] === "$") {
      result += "$";
      index += 2;
      continue;
    }
    const end = template.indexOf("$", index + 1);
    if (end < 0) fail(DASH_ERROR_CODES.INVALID_TEMPLATE, "DASH template contains an unterminated token.");
    const token = template.slice(index + 1, end);
    const match = /^(RepresentationID|Bandwidth|Number|Time)(%0\d+d)?$/.exec(token);
    if (!match) fail(DASH_ERROR_CODES.INVALID_TEMPLATE, `DASH template token ${token} is unsupported.`);
    const key = match[1];
    const value = values[key];
    if (value === null || value === undefined) fail(DASH_ERROR_CODES.INVALID_TEMPLATE, `DASH template token ${key} has no value.`);
    result += key === "RepresentationID" ? String(value) : formatTemplateNumber(value, match[2]);
    index = end + 1;
    if (result.length > DASH_LIMITS.maxUrlCharacters) fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "Expanded DASH URL is too large.");
  }
  return result;
}

function expandTimeline(timeline, {
  timescale,
  periodDuration,
  presentationTimeOffset,
  startNumber,
  endNumber,
}) {
  const entries = childNodes(timeline, "S");
  if (!entries.length) fail(DASH_ERROR_CODES.INVALID_MANIFEST, "SegmentTimeline has no segments.");
  if (entries.length > DASH_LIMITS.maxTimelineEntries) fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "SegmentTimeline contains too many entries.");
  const parsed = entries.map((entry) => ({
    t: parseInteger(attribute(entry, "t"), "SegmentTimeline time"),
    d: parseInteger(attribute(entry, "d"), "SegmentTimeline duration", { minimum: 1, required: true }),
    r: parseInteger(attribute(entry, "r"), "SegmentTimeline repeat", { minimum: -1 }) ?? 0,
  }));
  const periodEnd = periodDuration === null ? null : presentationTimeOffset + periodDuration * timescale;
  const result = [];
  let currentTime = 0;
  let number = startNumber;
  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index];
    const start = entry.t === null ? currentTime : entry.t;
    if (start < 0) fail(DASH_ERROR_CODES.INVALID_MANIFEST, "SegmentTimeline time may not be negative.");
    let count;
    if (entry.r >= 0) {
      count = entry.r + 1;
    } else {
      const nextExplicit = parsed.slice(index + 1).find((candidate) => candidate.t !== null)?.t ?? null;
      const bound = nextExplicit !== null ? nextExplicit : periodEnd;
      if (endNumber !== null) {
        const numberBound = endNumber - number + 1;
        if (numberBound > 0) count = numberBound;
      }
      if (count === undefined && bound !== null) {
        const distance = bound - start;
        count = Math.floor(distance / entry.d);
      }
      if (!Number.isInteger(count) || count <= 0) {
        fail(DASH_ERROR_CODES.UNBOUNDED_TIMELINE, "SegmentTimeline repeat is unbounded.");
      }
    }
    if (count > DASH_LIMITS.maxSegmentsPerRepresentation || result.length + count > DASH_LIMITS.maxSegmentsPerRepresentation) {
      fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "DASH representation contains too many segments.");
    }
    if (endNumber !== null && number + count - 1 > endNumber) {
      fail(DASH_ERROR_CODES.INVALID_MANIFEST, "SegmentTimeline exceeds endNumber.");
    }
    for (let repeat = 0; repeat < count; repeat += 1) {
      const time = start + repeat * entry.d;
      result.push({ number, time, durationUnits: entry.d, duration: entry.d / timescale });
      number += 1;
    }
    currentTime = start + count * entry.d;
  }
  return result;
}

function deriveTemplateSegments(attrs, timeline, periodDuration) {
  const timescale = parsePositiveInteger(attrs.timescale, "SegmentTemplate timescale");
  const presentationTimeOffset = parseInteger(attrs.presentationTimeOffset, "SegmentTemplate presentationTimeOffset") ?? 0;
  const startNumber = parseInteger(attrs.startNumber, "SegmentTemplate startNumber") ?? 1;
  const endNumber = parseInteger(attrs.endNumber, "SegmentTemplate endNumber");
  if (endNumber !== null && endNumber < startNumber) fail(DASH_ERROR_CODES.INVALID_MANIFEST, "SegmentTemplate endNumber precedes startNumber.");
  const media = validateString(attrs.media, "SegmentTemplate media");
  if (!media) fail(DASH_ERROR_CODES.INVALID_MANIFEST, "SegmentTemplate media is missing.");
  const durationUnits = parseInteger(attrs.duration, "SegmentTemplate duration", { minimum: 1 });
  let segments;
  if (timeline) {
    segments = expandTimeline(timeline, {
      timescale,
      periodDuration,
      presentationTimeOffset,
      startNumber,
      endNumber,
    });
  } else {
    let count;
    if (endNumber !== null) {
      count = endNumber - startNumber + 1;
    } else if (periodDuration !== null && durationUnits !== null) {
      const mediaEnd = presentationTimeOffset + periodDuration * timescale;
      count = Math.max(0, Math.ceil(mediaEnd / durationUnits));
    } else {
      fail(DASH_ERROR_CODES.UNBOUNDED_TIMELINE, "SegmentTemplate duration has no finite period bound.");
    }
    if (count > DASH_LIMITS.maxSegmentsPerRepresentation) fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "DASH representation contains too many segments.");
    segments = Array.from({ length: count }, (_, index) => durationUnits === null ? ({
      number: startNumber + index,
      time: null,
      durationUnits: null,
      duration: null,
    }) : ({
      number: startNumber + index,
      time: index * durationUnits,
      durationUnits,
      duration: durationUnits / timescale,
    }));
  }
  const last = segments[segments.length - 1];
  const endUnits = last && last.time !== null && last.durationUnits !== null
    ? last.time + last.durationUnits : null;
  const endSeconds = endUnits === null ? null : Math.max(0, (endUnits - presentationTimeOffset) / timescale);
  return { segments, endSeconds, media, initialization: attrs.initialization || null };
}

function initializationRequest(rawSource, rawRange, baseUrl, values) {
  if (rawSource === null || rawSource === undefined || rawSource === "") return null;
  const source = substituteTemplate(validateString(rawSource, "DASH initialization"), values);
  return { url: safeUrl(source, baseUrl), range: parseRange(rawRange, "initialization range") };
}

function segmentRequest(url, range, metadata) {
  return {
    url,
    range: range || null,
    number: metadata.number,
    time: metadata.time,
    duration: metadata.duration,
  };
}

function buildTemplateSource(effective, baseUrl, representation, periodDuration) {
  const attrs = effective.attributes;
  rejectPathTraversal(validateString(attrs.media, "SegmentTemplate media"));
  const metadata = {
    RepresentationID: representation.id,
    Bandwidth: representation.bandwidth ?? 0,
  };
  const generated = deriveTemplateSegments(attrs, effective.timeline, periodDuration);
  const segments = generated.segments.map((entry) => {
    const url = safeUrl(substituteTemplate(generated.media, {
      ...metadata,
      Number: entry.number,
      Time: entry.time,
    }), baseUrl);
    return segmentRequest(url, null, entry);
  });
  const first = generated.segments[0] || { number: parseInteger(attrs.startNumber, "SegmentTemplate startNumber") ?? 1, time: 0 };
  const initialization = initializationRequest(generated.initialization, null, baseUrl, {
    ...metadata,
    Number: first.number,
    Time: first.time,
  });
  return { initialization, index: null, segments, endSeconds: generated.endSeconds };
}

function buildSegmentListSource(effective, baseUrl, representation) {
  const attrs = effective.attributes;
  const timescale = parsePositiveInteger(attrs.timescale, "SegmentList timescale");
  const durationUnits = parseInteger(attrs.duration, "SegmentList duration", { minimum: 1 });
  const startNumber = parseInteger(attrs.startNumber, "SegmentList startNumber") ?? 1;
  const urls = effective.segmentUrls || [];
  if (!urls.length) fail(DASH_ERROR_CODES.NO_MEDIA, "SegmentList contains no SegmentURL entries.");
  if (urls.length > DASH_LIMITS.maxSegmentsPerRepresentation) fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "SegmentList contains too many segments.");
  let timelineEntries = null;
  if (effective.timeline) {
    timelineEntries = expandTimeline(effective.timeline, {
      timescale,
      periodDuration: null,
      presentationTimeOffset: 0,
      startNumber,
      endNumber: null,
    });
    if (timelineEntries.length !== urls.length) fail(DASH_ERROR_CODES.INVALID_MANIFEST, "SegmentList timeline and URLs differ in length.");
  }
  const segments = urls.map((segment, index) => {
    const source = attribute(segment, "media");
    const url = safeUrl(source || baseUrl, baseUrl);
    const range = parseRange(attribute(segment, "mediaRange"), "SegmentURL mediaRange");
    const timeline = timelineEntries?.[index];
    const duration = timeline?.duration ?? (durationUnits === null ? null : durationUnits / timescale);
    return segmentRequest(url, range, {
      number: startNumber + index,
      time: timeline?.time ?? (durationUnits === null ? null : index * durationUnits),
      duration,
    });
  });
  const init = effective.initialization;
  const initialization = init
    ? initializationRequest(attribute(init, "sourceURL") || baseUrl, attribute(init, "range"), baseUrl, {
      RepresentationID: representation.id,
      Bandwidth: representation.bandwidth ?? 0,
      Number: startNumber,
      Time: 0,
    })
    : null;
  const endSeconds = segments.every((segment) => Number.isFinite(segment.duration))
    ? segments.reduce((total, segment) => total + segment.duration, 0) : null;
  return { initialization, index: null, segments, endSeconds };
}

function buildSegmentBaseSource(effective, baseUrl) {
  const init = effective.initialization;
  const initialization = init
    ? initializationRequest(attribute(init, "sourceURL") || baseUrl, attribute(init, "range"), baseUrl, {
      RepresentationID: null,
      Bandwidth: 0,
      Number: 1,
      Time: 0,
    })
    : null;
  const indexSource = effective.representationIndex;
  const indexRange = parseRange(attribute(indexSource, "range") || effective.attributes.indexRange, "SegmentBase indexRange");
  const indexUrl = indexSource && attribute(indexSource, "sourceURL")
    ? safeUrl(attribute(indexSource, "sourceURL"), baseUrl) : baseUrl;
  const index = indexRange ? { url: indexUrl, range: indexRange } : null;
  return { initialization, index, segments: [], endSeconds: null };
}

function inferKind(contentType, mimeType, codecs) {
  const value = `${contentType || ""} ${mimeType || ""} ${codecs || ""}`.toLowerCase();
  if (/\bvideo\b|video\//.test(value) || /(?:avc|av01|hev|hvc|vp0?8|vp0?9|theora|dvh)/.test(value)) return "video";
  if (/\baudio\b|audio\//.test(value) || /(?:mp4a|aac|ac-3|ec-3|ac-?4|opus|vorbis|vorb|mha[1-2])/.test(value)) return "audio";
  return null;
}

function inheritedString(nodes, names, maxLength = 256) {
  let value = null;
  for (const node of nodes) {
    for (const name of names) {
      if (hasAttribute(node, name)) value = validateString(attribute(node, name), name, maxLength).trim() || null;
    }
  }
  return value;
}

function inheritedInteger(nodes, names) {
  let value = null;
  for (const node of nodes) {
    for (const name of names) {
      if (hasAttribute(node, name)) value = parseInteger(attribute(node, name), name);
    }
  }
  return value;
}

function buildRepresentationPlan(nodes, baseInfo, periodDuration, counters) {
  const representationNode = nodes[nodes.length - 1];
  const contentType = inheritedString(nodes, ["contentType"]);
  const mimeType = inheritedString(nodes, ["mimeType"]);
  const codecs = inheritedString(nodes, ["codecs"]);
  const kind = inferKind(contentType, mimeType, codecs);
  if (!kind) return null;
  const id = optionalStringAttribute(representationNode, "id");
  const bandwidth = inheritedInteger(nodes, ["bandwidth"]);
  const width = inheritedInteger(nodes, ["width"]);
  const height = inheritedInteger(nodes, ["height"]);
  const language = inheritedString(nodes, ["lang", "language"], 128);
  const representation = {
    id,
    kind,
    mimeType,
    codecs,
    bandwidth,
    width,
    height,
    language,
  };
  const sourceName = effectiveSource(nodes);
  const effective = sourceName ? mergeDescriptor(nodes, sourceName) : null;
  let source;
  if (sourceName === "SegmentTemplate") source = buildTemplateSource(effective, baseInfo.url, representation, periodDuration);
  else if (sourceName === "SegmentList") source = buildSegmentListSource(effective, baseInfo.url, representation);
  else if (sourceName === "SegmentBase") source = buildSegmentBaseSource(effective, baseInfo.url);
  else {
    if (!baseInfo.explicit) fail(DASH_ERROR_CODES.NO_MEDIA, "DASH representation has no media URL.");
    source = {
      initialization: null,
      index: null,
      segments: [segmentRequest(baseInfo.url, null, { number: null, time: null, duration: null })],
      endSeconds: null,
    };
  }
  counters.requests += (source.initialization ? 1 : 0) + (source.index ? 1 : 0) + source.segments.length;
  if (counters.requests > DASH_LIMITS.maxTotalRequests) fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "DASH plan contains too many requests.");
  return {
    ...representation,
    initialization: source.initialization,
    index: source.index,
    segments: source.segments,
    _endSeconds: source.endSeconds,
  };
}

function containsDynamicAttributes(node) {
  const dynamicNames = new Set([
    "minimumUpdatePeriod", "timeShiftBufferDepth", "availabilityStartTime", "publishTime",
    "suggestedPresentationDelay", "availabilityTimeOffset", "availabilityTimeComplete",
  ]);
  if ([...dynamicNames].some((name) => hasAttribute(node, name))) return true;
  return node.children.some(containsDynamicAttributes);
}

function containsContentProtection(node) {
  if (node?.name === "ContentProtection") return true;
  return Array.isArray(node?.children) && node.children.some(containsContentProtection);
}

function rejectUnsupportedProtection(root) {
  if (containsContentProtection(root)) {
    fail(DASH_ERROR_CODES.DRM_PROTECTED, "DRM으로 보호된 DASH 영상은 지원하지 않습니다.");
  }
}

function rejectDynamicManifest(root) {
  const type = (attribute(root, "type") || "static").toLowerCase();
  if (type === "dynamic" || type === "live") fail(DASH_ERROR_CODES.DYNAMIC_MPD, "Dynamic and live MPDs are not supported.");
  if (type !== "static") fail(DASH_ERROR_CODES.INVALID_MANIFEST, "MPD type is invalid.");
  const profiles = (attribute(root, "profiles") || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (profiles.some((profile) => /(?:live|dynamic)/.test(profile))) {
    fail(DASH_ERROR_CODES.DYNAMIC_MPD, "Dynamic and live MPD profiles are not supported.");
  }
  if (containsDynamicAttributes(root)) fail(DASH_ERROR_CODES.DYNAMIC_MPD, "Dynamic and live MPD attributes are not supported.");
}

export function parseDashManifest(text, manifestUrl) {
  const canonicalManifestUrl = safeUrl(manifestUrl);
  const root = parseDashXml(text);
  rejectUnsupportedProtection(root);
  rejectDynamicManifest(root);
  const mpdDuration = parseDuration(attribute(root, "mediaPresentationDuration"), "mediaPresentationDuration");
  const rootBase = applyBaseUrl(root, { url: canonicalManifestUrl, explicit: false });
  const periodNodes = childNodes(root, "Period");
  if (!periodNodes.length) fail(DASH_ERROR_CODES.NO_MEDIA, "MPD contains no periods.");
  if (periodNodes.length > DASH_LIMITS.maxPeriods) fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "MPD contains too many periods.");

  const periodStarts = [];
  let cursor = 0;
  for (const period of periodNodes) {
    const explicitStart = parseDuration(attribute(period, "start"), "Period start");
    const start = explicitStart === null ? cursor : explicitStart;
    if (start < cursor) fail(DASH_ERROR_CODES.INVALID_MANIFEST, "Period starts are not ordered.");
    periodStarts.push(start);
    cursor = start;
  }

  const counters = { adaptations: 0, representations: 0, requests: 0 };
  const periods = [];
  let totalDerivedEnd = 0;
  for (let periodIndex = 0; periodIndex < periodNodes.length; periodIndex += 1) {
    const periodNode = periodNodes[periodIndex];
    const start = periodStarts[periodIndex];
    const nextStart = periodStarts[periodIndex + 1] ?? null;
    const explicitDuration = parseDuration(attribute(periodNode, "duration"), "Period duration");
    let periodDuration = explicitDuration;
    if (periodDuration === null && nextStart !== null) periodDuration = nextStart - start;
    if (periodDuration === null && mpdDuration !== null) periodDuration = Math.max(0, mpdDuration - start);
    const periodBase = applyBaseUrl(periodNode, rootBase);
    const adaptationNodes = childNodes(periodNode, "AdaptationSet");
    counters.adaptations += adaptationNodes.length;
    if (counters.adaptations > DASH_LIMITS.maxAdaptationSets) fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "MPD contains too many adaptation sets.");
    const adaptations = [];
    let derivedPeriodEnd = 0;
    for (const adaptationNode of adaptationNodes) {
      const adaptationBase = applyBaseUrl(adaptationNode, periodBase);
      const adaptationNodesForMetadata = [root, periodNode, adaptationNode];
      const adaptationContentType = inheritedString(adaptationNodesForMetadata, ["contentType"]);
      const adaptationMimeType = inheritedString(adaptationNodesForMetadata, ["mimeType"]);
      const adaptationCodecs = inheritedString(adaptationNodesForMetadata, ["codecs"]);
      const adaptationKind = inferKind(adaptationContentType, adaptationMimeType, adaptationCodecs);
      const adaptationLanguage = inheritedString(adaptationNodesForMetadata, ["lang", "language"]);
      const representationNodes = childNodes(adaptationNode, "Representation");
      counters.representations += representationNodes.length;
      if (counters.representations > DASH_LIMITS.maxRepresentations) fail(DASH_ERROR_CODES.LIMIT_EXCEEDED, "MPD contains too many representations.");
      const representations = [];
      for (const representationNode of representationNodes) {
        const representationBase = applyBaseUrl(representationNode, adaptationBase);
        const nodes = [root, periodNode, adaptationNode, representationNode];
        const plan = buildRepresentationPlan(nodes, representationBase, periodDuration, counters);
        if (!plan) continue;
        if (adaptationKind && plan.kind !== adaptationKind) plan.kind = adaptationKind;
        if (!plan.language && adaptationLanguage) plan.language = adaptationLanguage;
        representations.push(plan);
        if (plan._endSeconds !== null) derivedPeriodEnd = Math.max(derivedPeriodEnd, plan._endSeconds);
      }
      if (!representations.length) continue;
      adaptations.push({
        id: optionalStringAttribute(adaptationNode, "id"),
        kind: adaptationKind || representations[0].kind,
        mimeType: adaptationMimeType,
        codecs: adaptationCodecs,
        language: adaptationLanguage,
        representations: representations.map(({ _endSeconds, ...representation }) => representation),
      });
    }
    if (periodDuration === null && derivedPeriodEnd > 0) periodDuration = derivedPeriodEnd;
    if (periodDuration !== null) totalDerivedEnd = Math.max(totalDerivedEnd, start + periodDuration);
    if (!adaptations.length) fail(DASH_ERROR_CODES.NO_MEDIA, "MPD contains no audio or video representations.");
    periods.push({
      id: optionalStringAttribute(periodNode, "id"),
      start,
      duration: periodDuration,
      adaptationSets: adaptations,
    });
  }

  const duration = mpdDuration ?? (periods.every((period) => period.duration !== null) ? totalDerivedEnd : null);
  return {
    manifestUrl: canonicalManifestUrl,
    type: "static",
    duration,
    periods,
  };
}
