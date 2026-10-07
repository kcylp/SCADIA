# 这些字体文件的授权（为什么这里没有单独的 Roboto 许可原文）

`LICENSE-roboto.txt` 是 **Apache License 2.0 的完整原文**，与 `server/runtime/jobs/fonts/LICENSE.txt`
（随报表 PDF 字体一起分发的那一份）**逐字节相同**。它随本目录的 Roboto 网络字体一起提供，原因如下：

1. **Roboto 是 Apache-2.0 授权的字体**，版权归 Google。上游的 `google/fonts` 仓库在
   `apache/roboto/LICENSE.txt` 提供的就是这份 Apache 2.0 原文。
2. 本目录里的 `roboto-*-webfont.{ttf,woff,woff2}` 是同一套 Roboto 字面的 **web 转换版本**
   （sha256 与报表目录里的桌面版**不同**——已实测比对，所以不能靠"是同一个文件"来覆盖授权）。
   授权跟随**字体本身**，与容器格式无关，因此这一份 Apache 2.0 即适用。
3. **不写"待确认"**：Roboto 的授权是明确的（Apache-2.0），无需等后续确认。

**仍然待确认的**（不是 Roboto，是下面这两个）：

| 文件 | 现状 |
|---|---|
| `icomoon.{ttf,woff,eot}`、`myicons.{ttf,woff,eot}` | **自定义图标字体**。实测：文件内**没有可读的字体名或版权串**（只在 sfnt 目录里看到 `glyf/hmtx` 等表名），**无法从文件本身判定来源与授权**。需要由生成它们的人确认（常见情形是基于 Material Icons 的 Apache-2.0 子集，但**我不据此下结论**）。 |
| Roboto 的**中文/日文等 CJK 回退** | 仓内**没有任何 CJK 字体文件**（已全树扫描）。PDF 报表走的是 `server/runtime/jobs/helper/font-coverage.js` 的候选清单——它优先找**随包字体**（`NotoSansSC-Regular.ttf` / `SourceHanSansSC-Regular.ttf` / `simhei.ttf`，**目前都不在仓库里**），找不到才回退到操作系统字体（Windows `simhei.ttf`、Linux Noto CJK / 文泉驿）。**交付给第三方时这条必须确认**：随包不带 CJK 字体，就意味着报表中文依赖**目标机器的系统字体**。 |

写于 2026-10-03（批次 55）。
