# 桌面端启动：基线、白屏修复，与实测对比

2026-10-17 实测。被测对象是安装好的那份 `%LOCALAPPDATA%\tudouni-aigo\tudouni-aigo-desktop.exe`，
启动方式与双击桌面图标等价（`Start-Process` 指向桌面 `.lnk`，走 ShellExecute）。
每次采样前杀掉全部 `tudouni-aigo-desktop.exe` / `tudouni-aigo.exe` 并等 0.9–1.4 s。

## 一、结论

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 窗口第一次可见 | ~560 ms | 645–709 ms |
| 可见时窗口是什么 | **纯白** | 主题底色 + 启动提示 |
| 出现白帧 | **是，约 1.1 s** | **否** |
| 第一帧真实界面 | 1737 ms（中位数） | **1286 ms**（中位数） |
| 已运行再双击 | ~150 ms | ~150 ms（不变） |

修复后的实际观感：双击 →（约 0.7 s）深/浅色窗口出现，中间一个转圈 + "Starting…"
→（约 1.3 s）换成欢迎页。**全程没有白屏，也没有"点了没反应"。**

## 二、为什么会有那块白屏

从双击到出内容约 1.6 s，但这段不是一件事，用 `performance.timeOrigin` 对齐双击时刻后可以切开：

| 区间 | 时长 | 这段时间里存在什么 | 谁能填 |
| --- | --- | --- | --- |
| 窗口显示(560 ms) → 页面开始导航(~1335 ms) | **775 ms** | **没有任何文档** | 只有窗口背景色 |
| 导航 → body 背景色生效(1530 ms) | 195 ms | 文档有了，还是浏览器默认白 | 内联 splash |
| 背景色 → React 出内容(1882 ms) | 352 ms | 已是主题色 | 内联 splash |

前 775 ms 是键：**那段时间连 HTML 都不存在**，任何 splash/CSS/JS 都来不及，只有
Tauri 窗口自己的背景色能覆盖。这决定了修复必须分两层做。

（注：绝对值会随 WebView2 运行时是否"热"而漂移，上表取自同一时段的连续采样；
真正不随机器状态变化的是"有没有白帧"这个定性结论。）

## 三、改了什么

### 1. 窗口在正确底色下才显示

`src-tauri/tauri.conf.json`：

```json
"backgroundColor": "#12151A",
"visible": false
```

配置色只能有一个值，而主题有两套（深 `#12151A` / 浅 `#F1F5EF`），配错的那一套比白屏更刺眼。
所以配置里放深色（与 `index.html` 的 `data-theme="dark"` 默认一致），由 Rust 在**窗口显示之前**
按系统主题校正，然后才 `show()` —— 见 `show_window_in_its_own_colour`。

主题判定读注册表 `HKCU\...\Themes\Personalize\AppsUseLightTheme`，**不用 `window.theme()`**：
后者是 getter，会向事件循环发消息并阻塞等待，而这段代码跑在 `setup` 里——`setup` 在事件循环
启动**之前**执行，调它会把启动直接挂死。`tao` 自己判定主题时读的也是同一个键
（`dark_mode.rs`）。

`WINDOW_BG_DARK` / `WINDOW_BG_LIGHT` 是 `tokens.css` 里 `--bg` 的副本，由
`the_window_colours_match_the_stylesheet` 这个单元测试读源码比对来防漂移——否则改了
`--bg` 之后界面到处正确，唯独启动那 1.3 s 还在用旧色，没有人会去报。

### 2. 启动提示（纯 CSS，在 React 挂载前就能显示）

`index.html` 里一段静态标记 + 内联 `<style>`，三条约束都是被现有配置逼出来的：

- **不用 JavaScript、不用 web 字体。** CSP 是 `default-src 'self'` + `style-src 'self' 'unsafe-inline'`，
  内联 `<style>` 免费，内联 `<script>` 需要 hash。`@font-face` 会让首帧等字体下载——
  实测过，那正是把 FCP 拖到 1.5 s 的原因。用系统字体栈，首次绘制从 120 ms 提前到 72 ms。
- **自己消失，一条选择器**：`#root:not(:empty) + #splash { display: none; }`。React 首次
  commit 填满 `#root`，splash 就没了。没有定时器会在错误时刻触发，也没有代码会被忘记调用。
- **React 挂载失败时它就留着。** 这是更诚实的失败：一个写着 "Starting…" 的窗口，
  比一个什么都不说（也就是白矩形）的窗口交代得更多。

## 四、怎么验证的

不是看截图说"看起来好了"，而是三个独立口径：

**1. DOM 状态（最硬的证据）** —— 在页面自己的时钟里记录 splash 的存在与 `display`：
3 次冷启动全部满足 `shown(children=0)` → `hidden(children=1)`，splash 实际亮了
176–186 ms，并且每次都是被 React 的首次 commit 替换掉的。

**2. 像素** —— 窗口可见后逐帧采样颜色。修复后第一帧就是 `(242,245,239)`
（浅色 `--bg` 的 `#F1F5EF`，`PrintWindow` 读回来差 1 个色阶），帧内只有 2 种颜色，
即"底色已正确、内容还没来"。修复前同一位置是纯白。

> 一个踩过的坑：白检测阈值一开始写成"三通道 ≥235"，结果把浅色主题的 `#F1F5EF`
> 判成了白，差点得出"修复没生效"的错误结论。现在阈值是 ≥250 且占比 ≥90%，
> 只认纯白。

**3. 端到端计时** —— 同一套外部脚本（无调试端口）测"第一次画出真实界面"：

```
修复前: 1674, 1848, 1790, 1737, 1683, 1396 ms   → 中位数 1737 ms
修复后: 1257, 1302, 1286 ms                     → 中位数 1286 ms
```

## 五、复现方式

```powershell
# 端到端冷启动计时（会杀掉正在运行的实例）
.tmp-startup-bench.ps1 -Mode cold -Runs 3
.tmp-startup-bench.ps1 -Mode second            # 已运行再双击

# 页内里程碑（需要 WebView2 调试端口，会改变时序，只用于看阶段占比）
node .tmp-inpage.mjs "$env:LOCALAPPDATA\tudouni-aigo\tudouni-aigo-desktop.exe" 3

# splash 是否真的显示过（DOM 口径）
node .tmp-splash-dom.mjs "$env:LOCALAPPDATA\tudouni-aigo\tudouni-aigo-desktop.exe" 3
```

这些脚本是测量时的一次性工具，**没有提交**（`.tmp-` 前缀，已被清理）。需要重测时
按上面的方法重写即可；判据与阈值都在本文档里。

## 六、环境

- Windows，Micron 2300 NVMe SSD
- WebView2 Runtime 155.0.4283.60
- 桌面端 4.0.0，runtime 6.10.0
- 系统为浅色主题（`AppsUseLightTheme=1`），所以验证覆盖的是浅色分支；
  深色分支由同一个 `set_background_color` 调用覆盖（只是不校正，配置值即深色）

## 七、没有做的两件事

1. **首屏 bundle 仍是 1070 KB。** 按 sourcemap 精确归因：`react-dom` 205 KB、
   `highlight.js` 167 KB、markdown 全套 ~120 KB。其中语法高亮栈是被
   `Welcome → NoteRow(EntryView) → Markdown` 这条静态 import 拉进首屏的——欢迎页为了渲染
   几行 note，把整个高亮器拖了进来。摘掉它约能省 290 KB / 30–60 ms。
   **这是估算，未实测**，所以没有动。
2. **WebView2 渲染进程初始化（~1.1 s）没有碰。** 它是这 1.6 s 的大头，但 Tauri 2 没有
   暴露预热接口，能试的只有 `additionalBrowserArgs` 之类的小动作，收益不确定。
