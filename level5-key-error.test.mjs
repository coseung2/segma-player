import assert from "node:assert/strict";
import test from "node:test";
import { level5KeyErrorMessage, normalizeLevel5KeyError } from "./level5-key-error.js";

test("preserves safe Level5 diagnostic codes and rejects arbitrary page text", () => {
  assert.equal(normalizeLevel5KeyError("runtime-import-failed"), "runtime-import-failed");
  assert.equal(normalizeLevel5KeyError("level5-key-http-403"), "level5-key-http-403");
  assert.equal(normalizeLevel5KeyError("attacker supplied detail"), "level5-key-unavailable");
});

test("renders a concise copyable protected-HLS failure", () => {
  assert.equal(level5KeyErrorMessage("wasm-init-failed"),
    "보호된 영상 키 확인 실패: 영상 플레이어 보호 모듈 초기화에 실패했습니다. (wasm-init-failed)");
});
