import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(extensionDirectory, "manifest.json"), "utf8"),
);
const ruleset = JSON.parse(
  await readFile(path.join(extensionDirectory, "redirect-block-rules.json"), "utf8"),
);

function navigationRule() {
  const rules = ruleset.filter((rule) => rule.action?.type === "block");
  assert.equal(rules.length, 1, "expected exactly one static navigation block rule");
  return rules[0];
}

function matchesUrlFilter(url, urlFilter) {
  assert.ok(urlFilter.startsWith("||"), `unsupported test filter: ${urlFilter}`);
  const filter = urlFilter.slice(2);
  const pathStart = filter.indexOf("/");
  const filterDomain = pathStart === -1 ? filter : filter.slice(0, pathStart);
  const filterPath = pathStart === -1 ? "" : filter.slice(pathStart);
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const hostMatches = hostname === filterDomain || hostname.endsWith(`.${filterDomain}`);
  const urlPath = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  return hostMatches && urlPath.startsWith(filterPath);
}

test("static DNR rule blocks only the landing navigation path", () => {
  const rule = navigationRule();

  assert.deepEqual(manifest.declarative_net_request.rule_resources, [
    {
      id: "wherewindsmeet_redirect_block",
      enabled: true,
      path: "redirect-block-rules.json",
    },
  ]);
  assert.equal(rule.action.type, "block");
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame", "sub_frame"]);
  assert.equal(rule.condition.urlFilter, "||wherewindsmeetgame.com/ldysteam2/");

  const matchingUrls = [
    "https://www.wherewindsmeetgame.com/ldysteam2/?channel=pwngamesads&utm_source=pwngames&utm_campaign=pwn_h72na_youdao_all_jp_install_conversion_event_pc_20260121&utm_medium=_5653178&gsid=...&gsc=1",
    "https://wherewindsmeetgame.com/ldysteam2/",
    "http://ads.wherewindsmeetgame.com/ldysteam2/?campaign=test",
    "https://a.b.wherewindsmeetgame.com/ldysteam2/extra?query=1",
  ];
  const nonMatchingUrls = [
    "https://www.wherewindsmeetgame.com/",
    "https://www.wherewindsmeetgame.com/other/?channel=pwngamesads",
    "https://www.wherewindsmeetgame.com/ldysteam20/?channel=pwngamesads",
    "https://notwherewindsmeetgame.com/ldysteam2/?channel=pwngamesads",
  ];

  for (const url of matchingUrls) {
    assert.equal(matchesUrlFilter(url, rule.condition.urlFilter), true, `expected match: ${url}`);
  }
  for (const url of nonMatchingUrls) {
    assert.equal(matchesUrlFilter(url, rule.condition.urlFilter), false, `expected no match: ${url}`);
  }
});
