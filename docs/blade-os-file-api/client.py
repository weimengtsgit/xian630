"""blade-os 文件操作 API 客户端（Bearer 鉴权）。

仅依赖 requests：``pip install requests``

用法::

    from client import BladeFileClient
    c = BladeFileClient("http://115.190.152.1", "sk-blade-v3-xxxx")
    c.list("共享")                       # 列目录
    c.mkdir("共享/报表")                  # 建文件夹
    c.upload_bytes("共享", "a.txt", b"hi")  # 上传/写内容
    print(c.read_text("共享/a.txt"))      # 读文件

鉴权统一用 blade-oauth 的 Bearer 令牌（v3 PAT / JWT），无需 cookie / CSRF。
令牌从 blade-oauth ``GET /api/v1/pat/v3/default`` 获取。
"""

from __future__ import annotations

import os
from typing import Any


import requests


class BladeFileError(RuntimeError):
    """文件 API 返回非 2xx 时抛出。"""

    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(f"[{status}] {detail}")
        self.status = status
        self.detail = detail


class BladeFileClient:
    """blade-os ``/api/v1/files`` 文件操作客户端。

    :param base_url: blade-os 地址，如 ``http://115.190.152.1``（文件 API 在 80 端口）。
    :param token:    blade-oauth Bearer 令牌（推荐每用户 v3 PAT，形如 ``sk-blade-v3-…``）。
    """

    def __init__(self, base_url: str, token: str, *, timeout: float = 30.0) -> None:
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self._s = requests.Session()
        self._s.headers["Authorization"] = f"Bearer {token}"

    # ── 内部 ────────────────────────────────────────────
    def _url(self, path: str) -> str:
        return f"{self.base}/api/v1/files{path}"

    def _check(self, r: requests.Response) -> requests.Response:
        if r.status_code // 100 != 2:
            try:
                detail = r.json().get("detail", r.text)
            except Exception:
                detail = r.text
            raise BladeFileError(r.status_code, detail)
        return r

    # ── 读 ──────────────────────────────────────────────
    def list(self, path: str = "") -> list[dict]:
        """列目录，返回条目列表（name/path/is_dir/size/modified/extension）。"""
        r = self._check(self._s.get(self._url("/list"), params={"path": path}, timeout=self.timeout))
        return r.json()["items"]

    def stat(self, path: str) -> dict:
        """单个文件/目录详情。"""
        return self._check(
            self._s.get(self._url("/stat"), params={"path": path}, timeout=self.timeout)
        ).json()

    def download(self, path: str, dest: str | None = None) -> bytes | str:
        """下载文件。给 ``dest`` 则落盘并返回路径，否则返回字节。"""
        r = self._check(self._s.get(self._url("/download"), params={"path": path}, timeout=self.timeout))
        if dest:
            with open(dest, "wb") as f:
                f.write(r.content)
            return dest
        return r.content

    def read_text(self, path: str, encoding: str = "utf-8") -> str:
        """读取文本文件内容。"""
        data = self.download(path)
        assert isinstance(data, bytes)
        return data.decode(encoding)

    def search(self, keyword: str, path: str = "") -> list[dict]:
        """按文件名搜索。"""
        return self._check(
            self._s.get(
                self._url("/search"),
                params={"keyword": keyword, "path": path},
                timeout=self.timeout,
            )
        ).json()

    # ── 写 ──────────────────────────────────────────────
    def mkdir(self, path: str) -> dict:
        """建文件夹（支持多级）。"""
        return self._check(self._s.post(self._url("/mkdir"), json={"path": path}, timeout=self.timeout)).json()

    def new_file(self, path: str) -> dict:
        """建空文件（同名自动加序号）。"""
        return self._check(self._s.post(self._url("/new-file"), json={"path": path}, timeout=self.timeout)).json()

    def upload(self, path: str, *local_files: str) -> dict:
        """上传一个或多个本地文件到目录 ``path``。"""
        handles = [(p, open(p, "rb")) for p in local_files]
        try:
            files = [("files", (os.path.basename(p), fh)) for p, fh in handles]
            return self._check(
                self._s.post(self._url("/upload"), params={"path": path}, files=files, timeout=self.timeout)
            ).json()
        finally:
            for _, fh in handles:
                fh.close()

    def upload_bytes(self, path: str, name: str, data: bytes) -> dict:
        """把内存中的字节作为文件 ``name`` 上传到目录 ``path``（写内容）。"""
        return self._check(
            self._s.post(
                self._url("/upload"),
                params={"path": path},
                files={"files": (name, data)},
                timeout=self.timeout,
            )
        ).json()

    def rename(self, path: str, new_name: str) -> dict:
        return self._check(
            self._s.post(self._url("/rename"), json={"path": path, "new_name": new_name}, timeout=self.timeout)
        ).json()

    def delete(self, *paths: str) -> dict:
        """批量删除文件/目录。"""
        return self._check(
            self._s.post(self._url("/delete"), json={"paths": list(paths)}, timeout=self.timeout)
        ).json()

    def move(self, src: str, dst: str) -> dict:
        return self._check(
            self._s.post(self._url("/move"), json={"src": src, "dst": dst}, timeout=self.timeout)
        ).json()

    def copy(self, src: str, dst: str) -> dict:
        return self._check(
            self._s.post(self._url("/copy"), json={"src": src, "dst": dst}, timeout=self.timeout)
        ).json()

    def download_zip(self, paths: list[str], dest: str) -> str:
        """把多个文件/目录打包 zip 下载到 ``dest``。"""
        r = self._check(
            self._s.post(self._url("/download-zip"), json={"paths": paths}, timeout=self.timeout)
        )
        with open(dest, "wb") as f:
            f.write(r.content)
        return dest
