# dsh-windows-caption-safe

Windows 标题栏安全区通用对齐引擎。解决「界面右上角被原生最小化 / 最大化 / 关闭按钮压住」这一类问题。

A generic Windows caption safe-area engine for DeepSeek Harness client plugins. It
fixes the whole class of "surface sits under the native window controls" bugs.

> 本插件原名 `dsh-windows-lightbox-fix`（最初只为修图片预览）。v2 起改名为
> `dsh-windows-caption-safe`：它现在是**一个可复用的引擎 + 一组规则**，图片预览只是
> 其中一条内置规则。公共契约（`window.__dshCaptionSafe`、
> `--dsh-caption-safe-top`、`data-caption-safe*`）自 v2 起就是中性名，不随包名变化。

## 问题

DSH 桌面壳用 Electron 的 `titleBarStyle: "hidden"` + `titleBarOverlay` 把
最小化 / 最大化 / 关闭按钮画在 **Web 内容之上的原生图层**上。原生层不参与文档的
层叠上下文，所以**任何 `z-index` 都压不住它**。

宿主为这条按钮带预留了安全区，并通过 `@deepseek-ai/dsh-client-ui-layout` 发布成
`<html>` 上的 CSS 自定义属性：

```css
html[data-windows-titlebar]{
  --dsh-windows-titlebar-height: 40px;   /* preload 注入 */
  --dsh-frame-top-clearance:  40px;
  --dsh-frame-chrome-top:     40px;
  --dsh-frame-overlay-top:    60px;      /* clearance + 20px */
}
```

宿主自己的界面会遵守它，但第三方界面经常不遵守——原因在于**这份契约只以 CSS 变量的
形式发布，没有 JS 入口**：一个用 JS 定位的浮窗（`el.style.top = 12`）不查变量名
就不可能知道安全区存在。已确认的两个案例：

| 界面 | 写死的定位 | 结果 |
|---|---|---|
| `ui-primitives` 的 `ImageLightbox` | `.close{top:20px;right:20px}`，遮罩 `inset:0` | 关闭按钮压住窗口按钮，遮罩还盖住标题栏导致窗口拖不动 |
| `dsh-univer-office` 浮窗 | `initialRect` 从 `VIEWPORT_GUTTER = 12` 起算，`fitRect` 把 `y` 夹在 ≥12 | 浮窗标题栏永远在按钮带下面（`12 < 40`） |

同一仓库的 `settings-account` overlay 正确写了
`[data-windows-titlebar] .overlay{padding-top:var(--dsh-windows-titlebar-height)}`，
说明这是遗漏而非设计。

## 解决方式

不直接改 asar 里的包（会被升级覆盖，且影响所有用户），而是在运行期：

### 1. 把安全区归一成一份契约

- **CSS**：`<html>` 上的 `--dsh-caption-safe-top`
- **JS**：`window.__dshCaptionSafe`（`.safeTop` / `.active` / `.subscribe()` / `.registerRule()`）
- **标记**：`html[data-caption-safe]`——**只在内缩 > 0 时存在**，所以它同时是
  「需要避让」的纯 CSS 开关

取值链：**全屏（0）→ WCO 真实几何 → 宿主变量**。

- 优先读标准 `navigator.windowControlsOverlay.getTitlebarAreaRect()`，因此会跟随真实的
  覆盖层高度与最大化 / 还原（宿主历史上用过 32 / 36 / 40px，不硬编码）。
- WCO 缺失时回退到 `--dsh-frame-top-clearance`，再回退到
  `--dsh-windows-titlebar-height`。
- `visible === false` 的 WCO 视为幽灵 API（headless、macOS）忽略，避免凭空造出内缩。
- 全屏时按钮消失，强制为 0，否则会过度内缩。

### 2. 用声明式规则对齐无法用纯 CSS 表达的界面

一条规则就是一个小对象：`{ id, css?, sync?, restore? }`。

内置两条：

- **`image-lightbox`**——原修复。预览遮罩有 ARIA 地标
  (`[role=dialog][aria-modal=true]` + `img` + 带 `aria-label` 的按钮，三者同时满足)，
  但类名是构建期哈希、样式表命中不了，所以用 inline style 写入那个 overlay。
- **`univer-floating-window`**——`dsh-univer-office` 的浮窗。它的类名 `uvf_*` 是稳定名
  而非哈希，所以纯 CSS 就够；难点是 `top` 是 inline style、且带 `12 + n*24` 的层叠
  偏移，因此把每个窗口自己的 `top` 镜像进 `--caption-inline-top`，再由样式表加上内缩，
  不去猜层叠。最大化与全屏审阅面板是精确的 `inset`，不会把窗口挤出屏幕，
  同时用 `max-height` 兜住被拖到屏幕底部的情况。

### 3. 给能用纯 CSS 的界面一个零 JS 入口

任何元素加上属性即可避让：

```html
<div data-caption-safe-shift>   <!-- 整体下移安全区高度 -->
<div data-caption-safe-inset>   <!-- 预留顶部内边距 -->
```

## 给其他插件复用

注册一条规则（可在任意客户端插件里）：

```js
const off = window.__dshCaptionSafe.registerRule({
  id: "my-plugin:panel",
  css: "html[data-caption-safe] .my-panel{top:calc(8px + var(--dsh-caption-safe-top,0px)) !important}",
  sync: (ctx) => { for (const el of ctx.doc.querySelectorAll(".my-panel")) el.dataset.captionSafe = ""; },
  restore: (ctx) => { for (const el of ctx.doc.querySelectorAll("[data-caption-safe]")) delete el.dataset.captionSafe; },
});
// off() 撤销
```

只想要数值：

```js
const off = window.__dshCaptionSafe.subscribe((safeTop) => { /* 0 = 无需避让 */ });
```

## 关键实现细节

- **只在需要时存在**：内缩为 0（全屏 / 非 Windows / 无安全区）时，不注入任何样式表、
  不写文档，并撤销已做的 inline 改动。
- **等待顺序**：本插件以 `immediately` 激活，可能早于 preload 打标记和 layout 注入
  样式表。因此监听 `<html>` 标记、`<head>` 的样式表插入、`resize`、WCO 的
  `geometrychange`，以及 `data-fullscreen` 的变化。
- **不循环**：head 观察者不会被自己注入的样式表触发死循环——`ensureRuleStyle` 复用
  自己的 tag，`removeStyles` 只在 tag 仍存在时执行。
- **合并高频变更**：拖动浮窗每帧都会改 inline style，所以用 `requestAnimationFrame`
  合并成一次 pass。
- **可完全卸载**：以 `ctx.effect` 注册，停用时移除变量、标记、全部样式表、全局契约，
  并执行每条规则的 `restore`。

## 验证

```bash
node self-test.mjs       # 80 项：契约、包/入口身份、取值链、规则、生命周期、API、卸载
node geometry-check.mjs  # 36 项：注入的 calc() 算术（含 inset=0 的 no-op）
node live-check.mjs      # 端到端：确认运行中的 host 正按磁盘上的字节提供新 bundle
```

`self-test.mjs` 用最小 fake DOM 跑**真实发布的 `lib/client.js`**（不复制实现），
覆盖幽灵 WCO、抛异常的 WCO、零高度、全屏切换、迟到的样式表、规则注册/注销、
以及卸载后的文档还原；并校验 `exports.name` / 模块 id / `cordis.patch.yml` 行名
三者与 `package.json` 的包名一致。`geometry-check.mjs` 独立验算 CSS 产出的几何。
`live-check.mjs` 从 `/plugins/events` 读 graph、复算 revision 并抓取 bundle，
用于确认改动是否已经生效（无需重启）。

## 安装

在 Harness 会话中用 `plugin_manager` 的 `install_bundle`，`target` 传本目录绝对路径；
或在 Web 界面「插件 → 添加插件 → 本地路径」。

## 从 dsh-windows-lightbox-fix 升级（v1 → v2 改名）

包名变了，所以不是原地升级，需要改 profile 里的四处引用（无持久化状态，无需迁移）：

1. 目录改名：`plugins/dsh-windows-lightbox-fix` → `plugins/dsh-windows-caption-safe`
2. `profiles/<profile>/package.json`：`dsh.profile.bundles` 列表项，以及
   `dependencies` 的键与 `link:` 目标路径
3. `profiles/<profile>/pnpm-lock.yaml`：重跑 `pnpm install` 会自行重算（或手改三行）
4. `profiles/<profile>/node_modules/` 下的 junction/symlink 重建

`cordis.yml` **不用手改**：它是 Loader 的 include 根，每次启动都会被
`prepareProfile` 覆写为空根配置（`[]`），真正的组合来自 `dsh.profile.bundles`
顺序 + `cordis.patch.yml`。手改它会在下次启动时被丢弃。

## 卸载

插件管理器中停用并移除组合包即可，无持久化状态；若宿主未来通过 JS 正式发布安全区，
本插件可直接卸载。
