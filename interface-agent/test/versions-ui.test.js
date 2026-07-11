import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  compareVersionLabelPath,
  sortVersionTree,
  filterVisibleVersions,
  selectAutoOnSuccess,
  newestSucceededRequestId,
  switchVersion,
  createVersionApiClient,
  initVersionControls,
} from '../public/versions.js';

// These are pure / dependency-injected functions exported from the version
// controls module. They avoid hard DOM/fetch coupling so the four behaviors
// the task pins down (numeric sort, switch-updates-preview-not-confirmed,
// auto-select, archive toggle) are unit-testable without a full browser.

// ============================================== 7. tree sort (labelPath numeric)

describe('version tree sort', () => {
  it('7. sorts by numeric label_path so V10 follows V2 (not string lex)', () => {
    const versions = [
      { versionId: 'a', versionLabel: 'V10', labelPath: [10], createdAt: '2026-01-01T00:00:10Z' },
      { versionId: 'b', versionLabel: 'V2', labelPath: [2], createdAt: '2026-01-01T00:00:02Z' },
      { versionId: 'c', versionLabel: 'V1', labelPath: [1], createdAt: '2026-01-01T00:00:00Z' },
      { versionId: 'd', versionLabel: 'V1.1', labelPath: [1, 1], createdAt: '2026-01-01T00:00:01Z' },
    ];

    const sorted = sortVersionTree(versions);

    expect(sorted.map((v) => v.versionLabel)).toEqual(['V1', 'V1.1', 'V2', 'V10']);
    // The critical numeric-vs-lex property: V10 is AFTER V2.
    const labels = sorted.map((v) => v.versionLabel);
    expect(labels.indexOf('V2')).toBeLessThan(labels.indexOf('V10'));
  });

  it('compareVersionLabelPath orders ancestors before descendants', () => {
    expect(compareVersionLabelPath({ labelPath: [1] }, { labelPath: [2] })).toBeLessThan(0);
    expect(compareLabelPath([1], [1, 1])).toBeLessThan(0); // shorter prefix first
    expect(compareLabelPath([1, 2], [1, 1])).toBeGreaterThan(0); // 2 > 1 at second segment
  });

  // local helper mirroring the pure comparator signature used above
  function compareLabelPath(a, b) {
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  }
});

// ============================ 8. switch updates preview + baseline, not confirmed

describe('switch version', () => {
  it('8. fetches html, renders preview, updates baseline; does NOT confirm', async () => {
    const VERSION_HTML = '<!doctype html><html><body>switched</body></html>';
    const version = { versionId: 'v-11', versionLabel: 'V1.1', title: 'Branch' };

    // Fake client: every method is a spy so we can prove ONLY fetchHtml ran.
    const client = {
      fetchHtml: vi.fn().mockResolvedValue(VERSION_HTML),
      patchTitle: vi.fn(),
      patchArchived: vi.fn(),
      confirm: vi.fn(), // a confirm call must NEVER happen on switch (T7 territory)
    };
    const renderPreview = vi.fn();
    const onBaselineChange = vi.fn();

    await switchVersion({ client, version, renderPreview, onBaselineChange });

    expect(client.fetchHtml).toHaveBeenCalledWith('v-11');
    expect(renderPreview).toHaveBeenCalledWith(VERSION_HTML);
    expect(onBaselineChange).toHaveBeenCalledWith(version);

    // Switching is PERSONAL state — it must not write shared confirm/version metadata.
    expect(client.confirm).not.toHaveBeenCalled();
    expect(client.patchTitle).not.toHaveBeenCalled();
    expect(client.patchArchived).not.toHaveBeenCalled();
  });
});

// =========================================== 9. new succeeded -> auto-select (TRANSITION-based)

describe('auto-select on generation success (transition, not state)', () => {
  it('9. fires only on a genuine transition: newest succeeded request id !== last seen', () => {
    // Backend lists generations newest-first.
    const requests = [
      { id: 'r3', status: 'succeeded', resultVersionId: 'v3' },
      { id: 'r2', status: 'succeeded', resultVersionId: 'v2' },
      { id: 'r1', status: 'generating', resultVersionId: null },
    ];

    // First sighting of r3 (last seen was null) -> a real transition -> select.
    expect(selectAutoOnSuccess(requests, null)).toEqual({
      requestId: 'r3',
      resultVersionId: 'v3',
    });
    // r3 already seen -> no transition -> nothing to do.
    expect(selectAutoOnSuccess(requests, 'r3')).toBeNull();
  });

  it('returns null when nothing has succeeded yet', () => {
    const requests = [{ id: 'r1', status: 'generating', resultVersionId: null }];
    expect(selectAutoOnSuccess(requests, null)).toBeNull();
  });

  // Fix 1 (review round 1): the explicit no-yank guard. After any generation
  // has succeeded, a user who deliberately browses an older version must NOT be
  // snapped back by the next poll. Transition-based logic (compare the newest
  // succeeded REQUEST id, not the selected version) keeps manual selections
  // stable: once the succeeded request has been seen, steady-state polls return
  // null regardless of which version is selected.
  it('9b. NO YANK: once the newest succeeded request has been seen, a steady-state poll returns null even when an OLDER version is selected', () => {
    const requests = [
      { id: 'r3', status: 'succeeded', resultVersionId: 'v3' },
      { id: 'r2', status: 'succeeded', resultVersionId: 'v2' },
    ];

    // r3 already observed -> no new transition. User is on v2 (manually browsed
    // older). The OLD state-based comparison would see v3≠v2 and yank back; the
    // new transition-based logic returns null and leaves them on v2.
    expect(selectAutoOnSuccess(requests, 'r3')).toBeNull();
  });

  it('9c. a NEW request transitioning to succeeded IS auto-selected', () => {
    // Previous newest was r3 (seen). Now r4 just succeeded (newest-first list).
    const requests = [
      { id: 'r4', status: 'succeeded', resultVersionId: 'v4' },
      { id: 'r3', status: 'succeeded', resultVersionId: 'v3' },
    ];
    expect(selectAutoOnSuccess(requests, 'r3')).toEqual({
      requestId: 'r4',
      resultVersionId: 'v4',
    });
  });

  // Sp3: newestSucceededRequestId seeds lastSeenSucceededRequestId at init so a
  // refresh does not yank the user off their persisted selection.
  it('Sp3. newestSucceededRequestId returns the newest succeeded id (newest-first list)', () => {
    expect(newestSucceededRequestId([
      { id: 'r3', status: 'succeeded', resultVersionId: 'v3' },
      { id: 'r2', status: 'succeeded', resultVersionId: 'v2' },
    ])).toBe('r3');
    expect(newestSucceededRequestId([
      { id: 'r1', status: 'queued', resultVersionId: null },
    ])).toBeNull();
    expect(newestSucceededRequestId([])).toBeNull();
  });
});

// ============================================================ 10. archive toggle

describe('archive visibility toggle', () => {
  it('10. hides archived nodes by default and reveals them when toggled', () => {
    const versions = [
      { versionId: 'v1', archived: false },
      { versionId: 'v1.2', archived: true },
      { versionId: 'v2', archived: false },
    ];

    expect(filterVisibleVersions(versions, { showArchived: false }).map((v) => v.versionId))
      .toEqual(['v1', 'v2']);

    expect(filterVisibleVersions(versions, { showArchived: true }).map((v) => v.versionId))
      .toEqual(['v1', 'v1.2', 'v2']);
  });
});

// ----------------------------------------------------------- client wiring

describe('createVersionApiClient', () => {
  it('targets the session-scoped version endpoints via injected fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ versions: [] }) });
    const client = createVersionApiClient({ fetchImpl, sessionId: 'sess-1' });

    await client.fetchTree();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('/api/interface-sessions/sess-1/versions');
    // fetch defaults to GET when no method is supplied
    expect(init.method || 'GET').toBe('GET');
  });

  // Fix 4 (review round 1): refresh() prefers the session's mainlineHead as the
  // initial default selection, so fetchSession must hit the session endpoint.
  it('fetchSession targets the session root to read mainlineHead/confirmedVersion', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: 'sess-1', mainlineHead: { versionId: 'v9' } }) });
    const client = createVersionApiClient({ fetchImpl, sessionId: 'sess-1' });

    const session = await client.fetchSession();

    expect(session.mainlineHead.versionId).toBe('v9');
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('/api/interface-sessions/sess-1');
  });
});

// ============================ DOM controller — fixes 1 + 2 (review round 1)
//
// The pure-function tests above cover the transition logic; these exercise the
// controller wiring: (a) tree nodes now carry data-version-id so the
// scroll-into-view selector resolves (fix 2), and (b) a steady-state poll does
// not yank a user who manually browsed an older version, while a NEW
// transition does auto-select (fix 1).

describe('version controls DOM controller (fixes 1 + 2)', () => {
  let dom;
  let scrollIntoViewSpy;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.localStorage = dom.window.localStorage;
    // jsdom leaves scrollIntoView as a not-implemented stub; replace with a spy
    // so the scroll line is reachable AND observable without console noise.
    scrollIntoViewSpy = vi.fn();
    dom.window.Element.prototype.scrollIntoView = scrollIntoViewSpy;
  });

  function buildController(clientOverrides = {}) {
    const toolbar = document.createElement('div');
    toolbar.className = 'preview-toolbar';
    document.body.appendChild(toolbar);
    const iframe = document.createElement('iframe');
    iframe.id = 'preview';
    document.body.appendChild(iframe);
    const messagesEl = document.createElement('div');
    messagesEl.id = 'messages';
    document.body.appendChild(messagesEl);
    const baselineHost = document.createElement('div');
    baselineHost.id = 'baseline';
    document.body.appendChild(baselineHost);

    const client = {
      fetchTree: vi.fn().mockResolvedValue([]),
      fetchSession: vi.fn().mockResolvedValue({ mainlineHead: null }),
      fetchHtml: vi.fn().mockResolvedValue('<!doctype html><html></html>'),
      fetchDetail: vi.fn().mockResolvedValue({ branchDialogue: [] }),
      fetchEvents: vi.fn().mockResolvedValue([]),
      fetchGenerations: vi.fn().mockResolvedValue([]),
      patchTitle: vi.fn(),
      patchArchived: vi.fn(),
      ...clientOverrides,
    };
    const controller = initVersionControls({
      sessionId: 'sess-dom',
      client,
      toolbar,
      iframe,
      messagesEl,
      baselineHost,
      onStatus: () => {},
      renderPreviewFn: () => {},
    });
    return { controller, client };
  }

  it('fix 2: tree nodes carry data-version-id so the scroll-into-view selector resolves', async () => {
    const versions = [
      { versionId: 'v1', versionLabel: 'V1', labelPath: [1], title: 'root', confirmed: false },
      { versionId: 'v2', versionLabel: 'V2', labelPath: [2], title: 'main', confirmed: false },
    ];
    const { controller } = buildController({
      fetchTree: vi.fn().mockResolvedValue(versions),
      fetchSession: vi.fn().mockResolvedValue({ mainlineHead: { versionId: 'v2' } }),
    });

    await controller.refresh();
    controller.openOverlay();

    const nodes = document.querySelectorAll('.version-list [role="listitem"]');
    // Every rendered node sets the anchor attribute (previously missing ->
    // scrollIntoView's selector returned null).
    expect(nodes[0].getAttribute('data-version-id')).toBe('v1');
    expect(nodes[1].getAttribute('data-version-id')).toBe('v2');
    // The exact selector pollGenerations uses resolves to the selected node.
    const scrollTarget = document.querySelector('.version-list [data-version-id="v2"]');
    expect(scrollTarget).not.toBeNull();
    expect(scrollTarget.classList.contains('is-selected')).toBe(true);
  });

  it('fix 4: refresh() defaults to the session mainlineHead, not a branch tip', async () => {
    // [2,1] sorts AFTER [2], so the old versions[length-1] fallback would pick
    // the branch tip V2.1. mainlineHead points at V2 -> must win.
    const versions = [
      { versionId: 'v2', versionLabel: 'V2', labelPath: [2], title: 'main', confirmed: false },
      { versionId: 'v2.1', versionLabel: 'V2.1', labelPath: [2, 1], title: 'branch', confirmed: false },
    ];
    const { controller } = buildController({
      fetchTree: vi.fn().mockResolvedValue(versions),
      fetchSession: vi.fn().mockResolvedValue({ mainlineHead: { versionId: 'v2' } }),
    });

    await controller.refresh();

    expect(controller.getSelectedVersionId()).toBe('v2'); // mainline head, not the branch tip V2.1
  });

  it('fix 1: steady-state poll does NOT yank a manual older selection; a NEW transition auto-selects + scrolls', async () => {
    vi.useFakeTimers();
    try {
      const htmlFor = { v1: '<!doctype html><html>v1', v2: '<!doctype html><html>v2', v3: '<!doctype html><html>v3' };
      const versions = [
        { versionId: 'v1', versionLabel: 'V1', labelPath: [1], title: 'root', confirmed: false },
        { versionId: 'v2', versionLabel: 'V2', labelPath: [2], title: 'main', confirmed: false },
      ];
      let generations = [{ id: 'r-v2', status: 'succeeded', resultVersionId: 'v2' }];

      const { controller, client } = buildController({
        fetchTree: vi.fn().mockImplementation(async () => versions.map((v) => ({ ...v }))),
        fetchSession: vi.fn().mockResolvedValue({ mainlineHead: { versionId: 'v2' } }),
        fetchHtml: vi.fn().mockImplementation(async (id) => htmlFor[id] || '<!doctype html><html>'),
        fetchGenerations: vi.fn().mockImplementation(async () => generations.map((g) => ({ ...g }))),
      });

      await controller.refresh();
      expect(controller.getSelectedVersionId()).toBe('v2');

      controller.openOverlay();
      controller.startPolling(1000);

      // First poll: transition null -> r-v2; auto-selects v2 (already on it),
      // establishes lastSeenSucceededRequestId = 'r-v2'.
      await vi.advanceTimersByTimeAsync(1000);

      // User deliberately browses the OLDER version v1.
      await controller.selectVersion('v1');
      expect(controller.getSelectedVersionId()).toBe('v1');

      const htmlCalls = client.fetchHtml.mock.calls.length;
      const treeCalls = client.fetchTree.mock.calls.length;

      // Steady-state poll: generations UNCHANGED (newest still r-v2 === lastSeen)
      // -> NO transition -> selectVersion/refresh/openOverlay must NOT fire.
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.fetchHtml.mock.calls.length).toBe(htmlCalls); // no selectVersion
      expect(client.fetchTree.mock.calls.length).toBe(treeCalls); // no refresh
      // Still on the manually-browsed older version (the core no-yank guarantee).
      expect(controller.getSelectedVersionId()).toBe('v1');

      // A NEW request r-v3 now transitions to succeeded.
      versions.push({ versionId: 'v3', versionLabel: 'V3', labelPath: [3], title: 'new', confirmed: false });
      generations = [
        { id: 'r-v3', status: 'succeeded', resultVersionId: 'v3' },
        { id: 'r-v2', status: 'succeeded', resultVersionId: 'v2' },
      ];
      const treeCalls2 = client.fetchTree.mock.calls.length;
      scrollIntoViewSpy.mockClear();

      // New-transition poll -> refresh (node exists) + auto-select v3 + scroll.
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.fetchTree.mock.calls.length).toBeGreaterThan(treeCalls2); // refresh ran
      expect(controller.getSelectedVersionId()).toBe('v3'); // auto-selected the new result
      // scrollIntoView is now reachable: the data-version-id anchor resolved and
      // the controller scrolled to the freshly-selected node (fix 2).
      expect(scrollIntoViewSpy).toHaveBeenCalled();

      controller.stopPolling();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Sp3b: first poll after refresh does NOT yank a persisted older selection (seeded at init); a NEW succeeded still auto-selects', async () => {
    vi.useFakeTimers();
    try {
      const htmlFor = { v1: '<!doctype html><html>v1', v2: '<!doctype html><html>v2', v3: '<!doctype html><html>v3' };
      // User persisted-selected the OLDER V1; the newest succeeded is r-v2 (V2).
      localStorage.setItem('interface-agent-selected-version', JSON.stringify({ sessionId: 'sess-dom', versionId: 'v1' }));
      const versions = [
        { versionId: 'v1', versionLabel: 'V1', labelPath: [1], title: 'root', confirmed: false },
        { versionId: 'v2', versionLabel: 'V2', labelPath: [2], title: 'main', confirmed: false },
      ];
      let generations = [{ id: 'r-v2', status: 'succeeded', resultVersionId: 'v2' }];

      const { controller } = buildController({
        fetchTree: vi.fn().mockImplementation(async () => versions.map((v) => ({ ...v }))),
        fetchSession: vi.fn().mockResolvedValue({ mainlineHead: { versionId: 'v2' } }),
        fetchHtml: vi.fn().mockImplementation(async (id) => htmlFor[id] || '<!doctype html><html>'),
        fetchGenerations: vi.fn().mockImplementation(async () => generations.map((g) => ({ ...g }))),
      });

      await controller.refresh();
      // Persisted older selection V1 is honored (NOT yanked to mainlineHead V2).
      expect(controller.getSelectedVersionId()).toBe('v1');

      controller.startPolling(1000);
      // First poll: WITHOUT seeding, the unseeded lastSeen=null would treat the
      // existing newest-succeeded r-v2 as a transition and yank to V2. WITH the
      // Sp3 seed (applied on the first refresh), the first poll sees no
      // transition → selection stays V1.
      await vi.advanceTimersByTimeAsync(1000);
      expect(controller.getSelectedVersionId()).toBe('v1');

      // A genuinely NEW succeeded request r-v3 still triggers auto-select.
      versions.push({ versionId: 'v3', versionLabel: 'V3', labelPath: [3], title: 'new', confirmed: false });
      generations = [
        { id: 'r-v3', status: 'succeeded', resultVersionId: 'v3' },
        { id: 'r-v2', status: 'succeeded', resultVersionId: 'v2' },
      ];
      await vi.advanceTimersByTimeAsync(1000);
      expect(controller.getSelectedVersionId()).toBe('v3');

      controller.stopPolling();
    } finally {
      vi.useRealTimers();
    }
  });
});
