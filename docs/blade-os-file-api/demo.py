"""blade-os 文件操作 API 演示。

跑一遍：列目录 → 建文件夹 → 上传(写内容) → 读回 → 建空文件 → 再列 → 清理。
默认目标是「共享」文件夹（全用户共享盘），可改 ROOT 为 "" 操作用户自己的根目录。

用法::

    pip install requests
    python demo.py <base_url> <pat>
    # 例：python demo.py http://115.190.152.1 sk-blade-v3-xxxxxxxx
"""

from __future__ import annotations

import sys
import time

from client import BladeFileClient, BladeFileError

# 目标目录：共享盘。改成 "" 即操作当前用户自己的「我的文件」根。
ROOT = "共享"


def main() -> None:
    if len(sys.argv) >= 3:
        base_url, token = sys.argv[1], sys.argv[2]
    else:
        # 没传参数时用这里的默认值（请替换成你的环境）
        base_url = "http://<blade-os-host>"  # 例如 http://115.190.152.1
        token = "sk-blade-v3-xxxxxxxx"  # 替换为你的 blade-oauth v3 PAT

    c = BladeFileClient(base_url, token)

    print(f"== 列目录 {ROOT!r} ==")
    for it in c.list(ROOT):
        kind = "DIR " if it["is_dir"] else "FILE"
        print(f"   {kind} {it['path']}  size={it.get('size')}")

    ts = int(time.time())
    demo_dir = f"{ROOT}/demo-{ts}"

    print(f"\n== 建文件夹 {demo_dir!r} ==")
    print("   ", c.mkdir(demo_dir))

    print("\n== 上传文件(写内容) ==")
    content = f"hello from python demo @ {ts}\n".encode()
    print("   ", c.upload_bytes(demo_dir, "hello.txt", content))

    print("\n== 读回内容 ==")
    print("   ", repr(c.read_text(f"{demo_dir}/hello.txt")))

    print("\n== 建空文件 ==")
    print("   ", c.new_file(f"{demo_dir}/notes.md"))

    print(f"\n== 再列 {demo_dir!r} ==")
    for it in c.list(demo_dir):
        print(f"   {it['name']}  size={it.get('size')}")

    print("\n== 清理(删除 demo 目录) ==")
    print("   ", c.delete(demo_dir))
    print("\n完成 ✅")


if __name__ == "__main__":
    try:
        main()
    except BladeFileError as e:
        print(f"\nAPI 错误: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print(f"\n出错: {e}", file=sys.stderr)
        sys.exit(1)
