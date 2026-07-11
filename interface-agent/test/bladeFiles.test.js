import { describe, expect, it, vi } from 'vitest';
import { BladeFileError, createBladeFileClient } from '../src/lib/bladeFiles.js';

/**
 * Task 8 — Blade OS client list/remove additions.
 *
 * The client is built with an injected fetchClient (vi.fn) so no network is
 * touched. Each case asserts the request shape (method/URL/headers/body) and
 * the return parsing, mirroring how readText/mkdir/uploadText are exercised
 * elsewhere. Authentication must always be the Bearer PAT header; the PAT
 * itself must never appear in a request URL/query (it is a secret).
 */
function makeClient(fetchImpl) {
  return createBladeFileClient(
    {
      bladeOsBaseUrl: 'http://blade.example',
      bladeOsPat: 'sk-blade-v3-secret',
      bladeOsTimeoutMs: 5000,
    },
    fetchImpl,
  );
}

describe('bladeFiles.list', () => {
  it('GETs /api/v1/files/list?path= and returns the items array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          items: [
            { name: 'a', path: 'doc/a', is_dir: false, modified: '2026-07-10T00:00:00Z' },
            { name: 'b', path: 'doc/b', is_dir: true, modified: '2026-07-10T00:00:00Z' },
          ],
        }),
    });
    const client = makeClient(fetchImpl);

    const items = await client.list('共享/demo');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchImpl.mock.calls[0];
    // Path is passed as a query param, PAT is in the Authorization header only.
    expect(requestUrl).toBe('http://blade.example/api/v1/files/list?path=%E5%85%B1%E4%BA%AB%2Fdemo');
    expect(requestUrl).not.toContain('sk-blade');
    expect(init.method).toBeUndefined(); // GET
    expect(init.headers.Authorization).toBe('Bearer sk-blade-v3-secret');
    expect(items).toHaveLength(2);
    expect(items[1].is_dir).toBe(true);
  });

  it('returns [] when the body has no items field (missing dir)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    });
    const client = makeClient(fetchImpl);
    const items = await client.list('nope');
    expect(items).toEqual([]);
  });

  it('throws BladeFileError on a non-2xx without leaking the PAT into the message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 404,
      text: () => Promise.resolve('not found'),
      json: () => Promise.resolve({ detail: 'not found' }),
    });
    const client = makeClient(fetchImpl);
    await expect(client.list('missing')).rejects.toMatchObject({
      status: 404,
    });
    await expect(client.list('missing')).rejects.toBeInstanceOf(BladeFileError);
  });
});

describe('bladeFiles.remove', () => {
  it('POSTs /api/v1/files/delete with body {paths:[...]}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ ok: true }),
    });
    const client = makeClient(fetchImpl);

    const result = await client.remove(['doc/a/prototype.html', 'doc/b/prototype.html']);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchImpl.mock.calls[0];
    expect(requestUrl).toBe('http://blade.example/api/v1/files/delete');
    expect(requestUrl).not.toContain('sk-blade');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-blade-v3-secret');
    expect(JSON.parse(init.body)).toEqual({
      paths: ['doc/a/prototype.html', 'doc/b/prototype.html'],
    });
    expect(result).toEqual({ ok: true });
  });

  it('wraps a single string path into a one-element paths array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    });
    const client = makeClient(fetchImpl);
    await client.remove('doc/a/prototype.html');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      paths: ['doc/a/prototype.html'],
    });
  });

  it('throws BladeFileError on a non-2xx (caller collects per-path errors)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500,
      text: () => Promise.resolve('server error'),
      json: () => Promise.resolve({ detail: 'server error' }),
    });
    const client = makeClient(fetchImpl);
    await expect(client.remove(['doc/a/prototype.html'])).rejects.toBeInstanceOf(BladeFileError);
  });
});
