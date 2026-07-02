import { Blob } from 'node:buffer';
import nodeFetch from 'node-fetch';
import { createTimeoutSignal } from './deepseek.js';

export class BladeFileError extends Error {
  constructor(status, detail) {
    super(`[${status}] ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/$/, '');
}

function splitSharedFilePath(path) {
  const value = String(path || '').trim();
  const slashIndex = value.lastIndexOf('/');
  if (slashIndex < 0) {
    return { directory: '', name: value };
  }
  return {
    directory: value.slice(0, slashIndex),
    name: value.slice(slashIndex + 1),
  };
}

export function createBladeFileClient(config, fetchImpl = globalThis.fetch || nodeFetch) {
  const baseUrl = normalizeBaseUrl(config.bladeOsBaseUrl);
  const token = config.bladeOsPat;
  const timeoutMs = config.bladeOsTimeoutMs || 30000;

  async function check(response) {
    if (response.status >= 200 && response.status < 300) {
      return response;
    }

    let detail = await response.text();
    try {
      detail = JSON.parse(detail).detail || detail;
    } catch {
      // 文件服务可能返回纯文本错误；保留原始文本便于排查。
    }
    throw new BladeFileError(response.status, detail);
  }

  function url(pathname) {
    return `${baseUrl}/api/v1/files${pathname}`;
  }

  function authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${token}`,
      ...extra,
    };
  }

  const client = {
    async readText(path) {
      const search = new URLSearchParams({ path });
      const response = await fetchImpl(`${url('/download')}?${search}`, {
        headers: authHeaders(),
        signal: createTimeoutSignal(timeoutMs),
      });
      const checked = await check(response);
      return checked.text();
    },

    async mkdir(path) {
      const response = await fetchImpl(url('/mkdir'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ path }),
        signal: createTimeoutSignal(timeoutMs),
      });
      const checked = await check(response);
      return checked.json();
    },

    async uploadText(path, content) {
      const { directory, name } = splitSharedFilePath(path);
      if (!name) {
        throw new BladeFileError(400, '输出文件路径缺少文件名。');
      }
      if (directory) {
        try {
          await client.mkdir(directory);
        } catch (error) {
          if (error?.status !== 400 && error?.status !== 409) {
            throw error;
          }
          // 输出目录可能已存在；继续上传，由上传接口判定最终路径是否可写。
        }
      }

      const form = new FormData();
      const data = new Blob([Buffer.from(String(content), 'utf8')], {
        type: 'text/html;charset=utf-8',
      });
      form.append('files', data, name);

      const search = new URLSearchParams({ path: directory });
      const response = await fetchImpl(`${url('/upload')}?${search}`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
        signal: createTimeoutSignal(timeoutMs),
      });
      const checked = await check(response);
      return checked.json();
    },
  };

  return client;
}
