# 部署到 GitHub Pages（零基础图文步骤）

本文件夹 `deploy-ghpages/` 就是**完整可上传的静态网站**，无需任何后端、无需打包。按下面步骤操作，约 5 分钟即可在手机上长期使用。

> 重要前提：你还没有 GitHub 账号，第 1 步先注册（免费、不用绑卡、不用填支付信息）。

---

## 第 1 步：注册 GitHub 账号（2 分钟）
1. 手机或电脑浏览器打开 https://github.com
2. 点右上角 **注册 Sign up**。
3. 填：用户名（英文，例如 `xiaoming`）、邮箱、密码 → 按提示验证（收邮件 / 解人机验证）。
4. 注册完成，**登录**进去即可。记住你的**用户名**，后面网址要用。

---

## 第 2 步：新建一个仓库（Repository）
1. 登录后，点页面右上角 **+** → **新建仓库 New repository**。
2. 填写：
   - **仓库名称 Repository name**：`finance-assistant`（这是仓库名，决定网址）
   - **可见性 Visibility**：选 **公开 Public**（公开，GitHub Pages 免费版必须公开）
   - 不要勾 "添加 README 文件"（保持空仓库，方便整包上传）
3. 点 **创建仓库 Create repository**。

---

## 第 3 步：把本文件夹内容上传进去（整包）
> GitHub 网页上传**支持整个文件夹拖拽，子文件夹（css / js / assets）会自动保留**，放心拖。

**需要拉进仓库的文件清单（共 7 项，缺一不可）：**
- `index.html` ← 主页面（必须放在根目录）
- `manifest.webmanifest` ← PWA 清单
- `sw.js` ← 离线Service Worker
- `css/`（整个文件夹，里面 `styles.css`）
- `js/`（整个文件夹，里面 `api.js` `app.js` `remote.js` `store.js` `ui.js`）
- `assets/`（整个文件夹，里面 `icon-192.png` `icon-512.png` `icon.svg`）
- （可选）`部署到GitHubPages-步骤.md` ← 就是本说明，留着备忘也行

**操作步骤：**
1. 进入刚建好的空仓库页面（地址类似 `github.com/<你的用户名>/finance-assistant`）。
2. 把上面这些文件/文件夹**一起拖到网页里的「将你的文件拖拽到此处 / drag your files here」区域**。
   - 会显示正在上传多个文件，含 `css/`、`js/`、`assets/` 子目录（不要只拖单个 html，子目录要一起带过去）。
3. 上传完成后，页面底部 **提交更改 Commit changes** 的输入框写一句 `init`，点 **提交更改 Commit changes** 提交。

**提交后请确认仓库里能看到：** `index.html`、`css/`、`js/`、`assets/`（含 icon 图片）、`manifest.webmanifest`、`sw.js`。

---

## 第 4 步：开启 GitHub Pages（生成固定网址）
1. 仓库页面点顶部 **设置 Settings**。
2. 左侧点 **页面 Pages**（在「代码与自动化」分组下）。
3. **构建与部署 Build and deployment** → **源 Source** 选 **从分支部署 Deploy from a branch**。
4. **分支 Branch** 选 **main**（若下拉里没有 main，先确认第 3 步提交到了哪个分支，默认是 main）。
5. **文件夹 Folder** 选 **/（根目录）/(root)**。
6. 点 **保存 Save**。

等待约 **1 分钟**，页面会显示一行绿色网址，形如：
```
https://<你的用户名>.github.io/finance-assistant/
```
这就是你永久的 App 网址。

---

## 第 5 步：手机上使用（添加到主屏幕）
1. 手机（iPhone / 安卓）浏览器打开上面的网址。
2. **iPhone（Safari）**：点底部「分享」按钮 → **添加到主屏幕** → 取名「家庭财务」→ 完成。之后桌面上就有图标，像 App 一样打开，可离线使用。
3. **安卓（Chrome）**：点右上角 ⋮ → **安装应用 / 添加到主屏幕**。
4. 数据**只存在这部手机**里。换手机或清浏览器数据会丢，请定期在 App 内「个人中心 → 导出备份」存一份 JSON 到手机/网盘。

---

## 常见问题
- **图标上传后是灰的/没图？** 已为你生成 PNG 图标（icon-192/512.png）并接入，正常会显示蓝色「增长」图标。
- **打开后一直转圈 / 白屏？** 多等 1–2 分钟（Pages 首次部署有延迟）；或用电脑浏览器打开网址看控制台报错。
- **行情不显示？** 基金估值依赖天天基金公开接口，需手机联网；非交易时间显示上一交易日净值属正常。
- **想改代码再更新？** 改完 `deploy-ghpages/` 里对应文件，回到第 3 步重新上传提交即可，网址不变。

> 之前在公司 Mac 上跑的 Node 服务与此无关，Mac 回收不影响本方案——代码已不在那台机器上了。
