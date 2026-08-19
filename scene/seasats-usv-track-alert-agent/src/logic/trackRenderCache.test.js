import test from "node:test";
import assert from "node:assert/strict";
import {
  requestTrackRender,
  cancelTrackRender,
  readSettledTrackRender,
  resetTrackRenderCacheForTests,
  TRACK_RENDER_CACHE_TTL_MS,
} from "./trackRenderCache.js";

// 可控的 fetch 替身：手动 resolve/reject，并记录调用与 signal。
function makeFetchStub() {
  const calls = [];
  const pending = [];
  const stub = (url, options = {}) => {
    calls.push({ url, options });
    let resolveFetch;
    const promise = new Promise((resolve) => { resolveFetch = resolve; });
    pending.push(resolveFetch);
    return promise;
  };
  stub.calls = calls;
  stub.resolveNext = (payload) => pending.shift()({ ok: true, json: async () => payload });
  stub.rejectNext = () => pending.shift()({ ok: false, json: async () => ({}) });
  return stub;
}

test("同一 MMSI 复用 in-flight 请求：重复调用不重复 fetch", () => {
  resetTrackRenderCacheForTests();
  const fetchStub = makeFetchStub();
  const first = requestTrackRender("111111111", fetchStub);
  const second = requestTrackRender("111111111", fetchStub);
  assert.equal(first.promise, second.promise);
  assert.equal(fetchStub.calls.length, 1);
  assert.match(fetchStub.calls[0].url, /\/track\?render=1$/);
  resetTrackRenderCacheForTests();
});

test("请求完成后结果缓存复用，失败/空载荷 settle 为 null 供回退", async () => {
  resetTrackRenderCacheForTests();
  const fetchStub = makeFetchStub();
  const entry = requestTrackRender("222222222", fetchStub);
  fetchStub.resolveNext({ trackPoints: [{ time: "2026-01-01T00:00:00Z", lon: 120, lat: 20 }], renderGaps: [], renderGapCount: 0 });
  const result = await entry.promise;
  assert.equal(result.points.length, 1);
  assert.deepEqual(result.gaps, []);
  assert.equal(entry.settled, true);
  // 再次请求：命中缓存，不再发 fetch。
  const again = requestTrackRender("222222222", fetchStub);
  assert.equal(again.promise, entry.promise);
  assert.equal(fetchStub.calls.length, 1);
  // 空载荷视为失败：settle 为 null。
  const empty = requestTrackRender("333333333", fetchStub);
  fetchStub.resolveNext({ trackPoints: [] });
  assert.equal(await empty.promise, null);
  assert.equal(empty.settled, true);
  resetTrackRenderCacheForTests();
});

test("cancelTrackRender 中止未完成请求并移除条目；已完成结果保留缓存", async () => {
  resetTrackRenderCacheForTests();
  const fetchStub = makeFetchStub();
  // 未完成：cancel 触发 abort 并删除条目，下次请求重新发起。
  const pending = requestTrackRender("444444444", fetchStub);
  assert.equal(pending.controller.signal.aborted, false);
  cancelTrackRender("444444444");
  assert.equal(pending.controller.signal.aborted, true);
  const refetch = requestTrackRender("444444444", fetchStub);
  assert.notEqual(refetch.promise, pending.promise);
  assert.equal(fetchStub.calls.length, 2);
  // 已完成：cancel 不影响缓存（弹窗重复打开直接复用，不重复请求）。
  // 替身的 FIFO 队列里被中止条目的请求仍挂起：先放行它（结果已无人消费），再放行重试请求。
  fetchStub.resolveNext({ trackPoints: [] });
  fetchStub.resolveNext({ trackPoints: [{ time: "2026-01-01T00:00:00Z", lon: 120, lat: 20 }] });
  await refetch.promise;
  cancelTrackRender("444444444");
  const cached = requestTrackRender("444444444", fetchStub);
  assert.equal(cached.promise, refetch.promise);
  assert.equal(fetchStub.calls.length, 2);
  resetTrackRenderCacheForTests();
});

test("readSettledTrackRender 仅在双侧都 settle 后返回结果", async () => {
  resetTrackRenderCacheForTests();
  const fetchStub = makeFetchStub();
  const reference = requestTrackRender("555555555", fetchStub);
  const carrier = requestTrackRender("666666666", fetchStub);
  assert.equal(readSettledTrackRender("555555555", "666666666"), null);
  fetchStub.resolveNext({ trackPoints: [{ time: "2026-01-01T00:00:00Z", lon: 120, lat: 20 }] });
  await reference.promise;
  // 单侧完成仍未就绪。
  assert.equal(readSettledTrackRender("555555555", "666666666"), null);
  fetchStub.rejectNext();
  await carrier.promise;
  const settled = readSettledTrackRender("555555555", "666666666");
  // 双侧 settle（一侧成功、一侧失败 null）→ 就绪，由调用方按 partial 处理。
  assert.deepEqual(settled, { reference: { points: [{ time: "2026-01-01T00:00:00Z", lon: 120, lat: 20 }], gaps: [], gapCount: 0 }, carrier: null });
  resetTrackRenderCacheForTests();
});

test("新快照 key 或缓存过期时不复用旧渲染轨迹", async () => {
  resetTrackRenderCacheForTests();
  const fetchStub = makeFetchStub();
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const first = requestTrackRender("777777777", fetchStub, "snapshot-a");
    fetchStub.resolveNext({ trackPoints: [{ time: "2026-01-01T00:00:00Z", lon: 120, lat: 20 }] });
    await first.promise;
    // 新快照不能读取旧快照的渲染序列，必须重新请求。
    assert.equal(readSettledTrackRender("777777777", "777777777", "snapshot-b"), null);
    const second = requestTrackRender("777777777", fetchStub, "snapshot-b");
    assert.notEqual(second.promise, first.promise);
    assert.equal(fetchStub.calls.length, 2);
    fetchStub.resolveNext({ trackPoints: [{ time: "2026-01-01T00:01:00Z", lon: 121, lat: 21 }] });
    await second.promise;
    // 同一快照超过 TTL 后同样不复用，避免长会话显示陈旧轨迹。
    now += TRACK_RENDER_CACHE_TTL_MS;
    const third = requestTrackRender("777777777", fetchStub, "snapshot-b");
    assert.notEqual(third.promise, second.promise);
    assert.equal(fetchStub.calls.length, 3);
  } finally {
    Date.now = originalNow;
    resetTrackRenderCacheForTests();
  }
});
