# Seasats 线上轨迹回放数据修改 Runbook

本文记录 `sf-seasats-monitor` 线上静态应用的三类高频修改：

1. 修改球形地图回放结束时间。
2. 新增单船。
3. 给船追加增量轨迹数据。

适用服务：

```text
页面地址：http://220.154.5.91:18003
SSH：root@220.154.5.91 -p 22
Podman 容器：sf-seasats-monitor
静态目录：/opt/seasats-monitor/releases/seasats-monitor-20260702-133901-1c8fd39/dist
```

注意：不要只覆盖原 JS/JSON 文件。`/assets/` 下资源会被浏览器强缓存，改完必须生成新的文件名，并更新 `index.html` 引用。

## 当前线上文件

```text
dist/index.html
dist/assets/index-C-4arM1M-20260715-incr202606.js
dist/assets/seasatsPayload-B6H6JGpq-incr202606.json
```

前端数据流：

```text
index.html
  -> /assets/index-*.js
    -> /assets/seasatsPayload-*.json
```

回放地图 URL 在 JS 中由当前选中船的 `mmsi` 拼接：

```text
http://218.61.33.200:18000/?mmsi={当前选中mmsi}&start_time={start}&end_time={end}
```

因此修改时间戳是全局生效，不是只针对某一条 MMSI。

## 1. 修改球形地图结束时间

### 目标

把 JS 中全局兜底回放时间：

```js
L_={start:1764954060,end:1782237606}
```

改成：

```js
L_={start:1764954060,end:1784131200}
```

北京时间对应：

```text
1764954060 -> 2025-12-06 01:01:00
1784131200 -> 2026-07-16 00:00:00
```

### 操作

```bash
ssh root@220.154.5.91 -p 22

d=/opt/seasats-monitor/releases/seasats-monitor-20260702-133901-1c8fd39/dist
old_js="$d/assets/index-C-4arM1M.js"
new_js="$d/assets/index-C-4arM1M-20260715.js"

cp -p "$old_js" "$new_js"
cp -p "$d/index.html" "$d/index.html.bak-$(date +%Y%m%d%H%M%S)"

python3 - <<'PY'
from pathlib import Path

d = Path("/opt/seasats-monitor/releases/seasats-monitor-20260702-133901-1c8fd39/dist")
js = d / "assets/index-C-4arM1M-20260715.js"
s = js.read_text(encoding="utf-8")
s = s.replace("L_={start:1764954060,end:1782237606}", "L_={start:1764954060,end:1784131200}")
js.write_text(s, encoding="utf-8")

index = d / "index.html"
html = index.read_text(encoding="utf-8")
html = html.replace("/assets/index-C-4arM1M.js", "/assets/index-C-4arM1M-20260715.js")
index.write_text(html, encoding="utf-8")
PY
```

### 验证

```bash
curl -fsS http://127.0.0.1:18003/ | grep -o 'assets/index-[^"[:space:]]*\.js'
curl -fsS http://127.0.0.1:18003/assets/index-C-4arM1M-20260715.js \
  | grep -o 'L_={start:1764954060,end:[0-9]*}' | head -1
```

期望：

```text
assets/index-C-4arM1M-20260715.js
L_={start:1764954060,end:1784131200}
```

## 2. 新增单船

### 输入 CSV 格式

单船 CSV 示例：

```text
task_id,hull_no,quire_time,vessel_name,mmsi,...,lng,lat,speed,speed_km,rate_of_turn,orientation,heading,...,ais_source_type,flag_country,sea_name,provider,confidence
TEMP,SD3002,2026-07-15 10:01:56,SD3002,338432796,...,147.83461,12.88942,0.8,1.48,0,99.1,511,...,1,USA,北太平洋,beiyou,1
```

### 原则

- 用原始线上 payload 或当前线上 payload 作基线。
- `targets` 增加一条最新位置。
- `trackPoints` 追加该船轨迹点。
- 同一 MMSI 已存在时先确认是否要替换、追加还是只取某个时间段。
- 生成新的 JSON 文件名。
- 生成新的 JS 文件名指向新 JSON。
- 更新 `index.html` 指向新 JS。

### 生成 payload 模板

把 CSV 上传到服务器：

```bash
scp -P 22 /path/to/338432796.csv root@220.154.5.91:/tmp/338432796.csv
```

在服务器执行：

```bash
ssh root@220.154.5.91 -p 22

d=/opt/seasats-monitor/releases/seasats-monitor-20260702-133901-1c8fd39/dist
old_payload="$d/assets/seasatsPayload-B6H6JGpq.json"
new_payload="$d/assets/seasatsPayload-B6H6JGpq-338432796.json"
old_js="$d/assets/index-C-4arM1M-20260715.js"
new_js="$d/assets/index-C-4arM1M-20260715-338432796.js"

cp -p "$old_payload" "$old_payload.bak-$(date +%Y%m%d%H%M%S)"
cp -p "$old_js" "$old_js.bak-$(date +%Y%m%d%H%M%S)"
cp -p "$d/index.html" "$d/index.html.bak-$(date +%Y%m%d%H%M%S)"
```

用 Python 将 CSV 转成前端 payload 结构。核心字段映射：

```text
CSV quire_time     -> trackPoints[].time / targets[].latestTime，格式转 ISO Z
CSV lng            -> lon
CSV lat            -> lat
CSV speed          -> speedKn / speedRawDiv10
CSV speed_km       -> speedKmh
CSV orientation    -> orientation / courseDeg
CSV heading        -> heading
CSV vessel_name    -> targets[].name
CSV mmsi           -> targets[].mmsi / trackPoints[].mmsi
```

写入后更新元数据：

```text
metadata.targetCount
metadata.trackPointCount
metadata.trackMmsiCount
metadata.dataWindow.start/end
metadata.dataWindow.latestPositionStart/latestPositionEnd
```

### 更新 JS 和首页引用

```bash
python3 - <<'PY'
from pathlib import Path

d = Path("/opt/seasats-monitor/releases/seasats-monitor-20260702-133901-1c8fd39/dist")

old_js = d / "assets/index-C-4arM1M-20260715.js"
new_js = d / "assets/index-C-4arM1M-20260715-338432796.js"
s = old_js.read_text(encoding="utf-8")
s = s.replace("/assets/seasatsPayload-B6H6JGpq.json", "/assets/seasatsPayload-B6H6JGpq-338432796.json")
new_js.write_text(s, encoding="utf-8")

index = d / "index.html"
html = index.read_text(encoding="utf-8")
html = html.replace("/assets/index-C-4arM1M-20260715.js", "/assets/index-C-4arM1M-20260715-338432796.js")
index.write_text(html, encoding="utf-8")
PY
```

### 验证

```bash
python3 - <<'PY'
import json
import urllib.request

base = "http://127.0.0.1:18003"
html = urllib.request.urlopen(base + "/").read().decode("utf-8")
print("html_has_new_js", "/assets/index-C-4arM1M-20260715-338432796.js" in html)

js = urllib.request.urlopen(base + "/assets/index-C-4arM1M-20260715-338432796.js").read().decode("utf-8")
print("js_has_new_payload", "/assets/seasatsPayload-B6H6JGpq-338432796.json" in js)

p = json.load(urllib.request.urlopen(base + "/assets/seasatsPayload-B6H6JGpq-338432796.json"))
print("has_target", any(str(t.get("mmsi")) == "338432796" for t in p["targets"]))
print("points", sum(1 for x in p["trackPoints"] if str(x.get("mmsi")) == "338432796"))
PY
```

## 3. 给船加增量数据

### 目标

增量目录示例：

```text
/Users/ohrvo/Downloads/mmsi_tracks 2
```

规则：

- 原始线上历史数据保留。
- 只追加 `2026-06-01T00:00:00Z` 之后的数据。
- 对线上已存在的 MMSI，只追加晚于该 MMSI 当前最大 `trackPoints[].time` 的点。
- 对新增 MMSI，只导入 2026 年 6 月之后的点。
- 不覆盖 6 月以前的原始数据。

### 本地生成增量 payload

先从线上原始 payload 拉基线，避免把临时测试文件当成基线：

```python
original_url = "http://220.154.5.91:18003/assets/seasatsPayload-B6H6JGpq.json"
```

生成逻辑：

```python
cutoff = "2026-06-01T00:00:00Z"

for csv_row in csv_files:
    mmsi = row["mmsi"]
    time = row["quire_time"].replace(" ", "T") + "Z"

    if time < cutoff:
        skip()

    if time <= existing_max_time_by_mmsi[mmsi]:
        skip()

    append_track_point()
    update_target_latest_position()
```

本次实际结果：

```text
输入 CSV 文件：167
非空 CSV 文件：53
输入行数：400669
追加轨迹点：386671
跳过旧数据或已存在时间点：13998
新增 targets：29
更新 targets：23
最终 targetCount：108
最终 trackPointCount：405762
最终 trackMmsiCount：53
最终 dataWindowEnd：2026-07-15T13:48:29Z
```

关键验证：

```text
338414915 points 19091
min 2025-01-08T21:47:08Z
max 2026-06-24T02:00:25Z

338432796 points 1886
min 2026-06-01T00:17:41Z
max 2026-07-15T10:01:56Z
```

这说明：

- `338414915` 保持原始历史，没有重复追加已有的 6 月 24 日数据。
- `338432796` 只保留 2026 年 6 月后的增量，没有带入 2025 年数据。

### 上传并切换线上

```bash
scp -P 22 /tmp/seasatsPayload-B6H6JGpq-incr202606.json \
  root@220.154.5.91:/opt/seasats-monitor/releases/seasats-monitor-20260702-133901-1c8fd39/dist/assets/seasatsPayload-B6H6JGpq-incr202606.json
```

生成新的 JS：

```bash
ssh root@220.154.5.91 -p 22

d=/opt/seasats-monitor/releases/seasats-monitor-20260702-133901-1c8fd39/dist

python3 - <<'PY'
from pathlib import Path

d = Path("/opt/seasats-monitor/releases/seasats-monitor-20260702-133901-1c8fd39/dist")
src = d / "assets/index-C-4arM1M-20260715.js"
dst = d / "assets/index-C-4arM1M-20260715-incr202606.js"
s = src.read_text(encoding="utf-8")
s = s.replace("/assets/seasatsPayload-B6H6JGpq.json", "/assets/seasatsPayload-B6H6JGpq-incr202606.json")
dst.write_text(s, encoding="utf-8")
PY
```

更新首页引用：

```bash
python3 - <<'PY'
from pathlib import Path
import re

p = Path("/opt/seasats-monitor/releases/seasats-monitor-20260702-133901-1c8fd39/dist/index.html")
s = p.read_text(encoding="utf-8")
new = "/assets/index-C-4arM1M-20260715-incr202606.js"
refs = re.findall(r'/assets/index-[^"<> ]+\.js', s)
if len(refs) != 1:
    raise SystemExit(f"expected one script ref, got {refs}")
p.write_text(s.replace(refs[0], new), encoding="utf-8")
PY
```

### 公网验证

```bash
python3 - <<'PY'
import json
import urllib.request

base = "http://220.154.5.91:18003"

html = urllib.request.urlopen(base + "/", timeout=20).read().decode("utf-8")
print("html_has_new_js", "/assets/index-C-4arM1M-20260715-incr202606.js" in html)

js = urllib.request.urlopen(base + "/assets/index-C-4arM1M-20260715-incr202606.js", timeout=20).read().decode("utf-8")
print("js_has_new_payload", "/assets/seasatsPayload-B6H6JGpq-incr202606.json" in js)

p = json.load(urllib.request.urlopen(base + "/assets/seasatsPayload-B6H6JGpq-incr202606.json", timeout=60))
print("targetCount", p["metadata"]["targetCount"])
print("trackPointCount", p["metadata"]["trackPointCount"])
print("trackMmsiCount", p["metadata"]["trackMmsiCount"])
print("dataWindowStart", p["metadata"]["dataWindow"]["start"])
print("dataWindowEnd", p["metadata"]["dataWindow"]["end"])

for m in ["338414915", "338432796", "338256000"]:
    pts = [x for x in p["trackPoints"] if str(x.get("mmsi")) == m]
    times = [x.get("time") for x in pts]
    print(m, "points", len(pts), "min", min(times or [""]), "max", max(times or [""]))
PY
```

## 常见问题

### 页面时间还是旧的

原因通常是浏览器缓存了旧 JS。处理方式：

1. 确认 `index.html` 是否已经指向新的 JS 文件名。
2. 确认新 JS 里是否包含新的时间戳或新 JSON 文件名。
3. 普通刷新不生效时，让浏览器强刷。

验证：

```bash
curl -fsS http://220.154.5.91:18003/ | grep -o 'assets/index-[^"[:space:]]*\.js'
```

### 新船搜不到

检查三层：

```text
index.html 是否指向新 JS
新 JS 是否指向新 JSON
新 JSON 的 targets / trackPoints 是否包含该 MMSI
```

### 增量导入后历史被替换

不要用增量 CSV 直接重建全量。必须以线上原始 payload 为基线，然后按时间过滤追加。

### 列表排序看起来不是按分数

当前前端排序规则：

```text
1. status 优先级：异常行为舰艇 -> 高可信舰艇 -> 待核验舰艇 -> 仅最新位置
2. 同 status 下按 score 倒序
3. 同 score 下按 latestTime 倒序
```

`score` 不是纯异常分，而是综合关注/命中分。异常状态由告警类型决定，可能出现低分但被排到异常组前面的情况。
