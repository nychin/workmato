# 1.3.3 打包准备

当前状态：版本与构建准备完成，尚未生成或发布 1.3.3 安装包。

## 本次更新

- 新增临时便签：Alt+N 显隐、Alt+Z 全局速记、保鲜与归档、透明度和可点击恢复的鼠标穿透开关。
- 优化便签拖动、字体、列表宽度与边缘渐隐、自动／固定状态图标和首次淡入。
- 新增“番茄钟重置时间”，默认 00:00，独立放在“默认专注时长”下方；每日清零长休计数和当日番茄划线，不打断计时。
- 岩石上增加最多十层的当日番茄划线，重启后保留当天进度。

## 已完成检查

- package.json、package-lock.json 根版本和中英文 README 已同步为 1.3.3。
- npm ls --depth=0：依赖完整。
- npm run build、npx tsc --noEmit：通过。
- node --test tests/*.test.cjs：25 项通过。
- Electron 真实计时页验证：独立重置设置位置、04:30 保存、逐层划线、十层上限与归零通过。
- 构建中包含临时便签页面、预加载脚本、每日计数模块、两张小番茄图、十层计数素材和字体。
- 构建保留现有 Vite CJS、旧字体路径和大体积 chunk 提示，不阻断产物生成。

## 现有打包流程

工作目录：`D:\AI\tomato_gpt\app`。

```powershell
# NSIS 安装包；只生成本地产物
npm run pack -- --publish never

# 如需先检查免安装目录版
npm run pack:dir -- --publish never
```

沿用 electron-builder 配置：Windows x64、Electron 39.8.10、NSIS 安装目录可选、桌面与开始菜单快捷方式，以及中／英／日安装语言。卸载配置保留用户数据。

预期安装包：`release/workmato-setup-1.3.3.exe`；目录版：`release/win-unpacked`。release 目录内现有 1.3.2 等文件仍属于旧版本。

实际生成安装包后，检查安装、升级保留数据、托盘、Alt+N／Alt+Z 和快捷键占用提示，再用于分发。当前没有创建 Git 标签、提交或远程 Release。
