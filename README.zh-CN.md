<div align="center">

[🇺🇸 English](README.md) · [🇨🇳 中文](README.zh-CN.md)

[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-2391e6.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.2-brightgreen.svg)](https://github.com/nychin/workmato/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d6.svg)](#)

![](assets/hero.png)

</div>

# 工作番茄/Workmato

## 概述

- 工作番茄是一个桌面宠物风格的效率工具，主面板是像素卡通风格的番茄钟，此外还有一个任务流程管理器界面。
- **语言**：支持中文、英文、日语
- **系统要求**：Windows 10 / 11（64 位）。软件基于 Electron，理论上可跨平台。

## 功能特性

**像素UI**
- 精心绘制的像素卡通风格UI，包含闲置、专注、延时、休息等多个常规状态以及庆祝、鞭策等彩蛋状态，计时状态时还有呼吸动态效果

**正计时延时模式**
- 使用传统番茄钟时是否常常因为在手感火热时专注时间结束而感到苦恼？延时模式为你带来弹性的专注时间。
- 在专注时间结束后会自动进入正计时的延时模式，延时时间也计入专注时间。
- 手动结束延时模式后进入休息，自由的安排自己的专注时间，避免被结束提醒打断。

**自动计算休息时间**
- 可以选择自动计算休息时长，在设置中调整计算的比例等参数

**无按钮设计**
- 伪装成场景元素的功能按钮，UI界面更加生动协调

**告示牌**
- 实时显示任务画布中挂起的任务，帮你保持专注
- 点击告示牌即可打开任务流程管理器

**任务流程画布**
- 适用轻量个人流程规划需求的任务管理器
- 多种符合直觉的卡片添加方式快速调整任务流程
- 无限节点画布，流畅的文本编辑体验，支持多种节点满足子任务规划和备注需求

**统计**
- 番茄钟和任务管理器一同使用时可以对每个任务的每个环节所耗费的时间进行统计，跟踪自己的工作状态

**庆祝动画**
- 当任务完成时小番茄会一起庆祝（处于专注状态时）

![](assets/celebration.gif)

## 其它界面预览

### 番茄钟

![](assets/tomato-buttons.png)
![](assets/tomato-ui.png)

### 任务流程管理器

![](assets/taskflow.png)

### 统计

![](assets/statistics.png)

## 安装

### 下载

从 [Releases](https://github.com/nychin/workmato/releases) 下载 `workmato-setup-1.3.2.exe`（NSIS 安装包，可自定义安装目录），适用 Windows 10 / 11（64 位）。

### 说明

安装完成后在任务管理器中查看使用说明

## 从源码运行（Quick Start）

需要 Node.js 18+ 与 npm：

```bash
npm install          # 安装依赖
npm run dev          # 开发模式：vite 热更新 + 自动启动（含任务流程画布源码）
npm run build        # 构建（主进程 + 渲染进程产物到 dist/）
npm run test:taskflow  # 任务数据存储迁移测试
npm run pack         # 打包 NSIS 安装包（release/workmato-setup-<版本>.exe）
npm run pack:dir     # 打包免安装目录版（release/win-unpacked）
```

开发模式使用独立的数据目录（`%TEMP%\tomato-clock-dev`），与正式安装版数据互相隔离，调试不会污染真实任务数据。

## 技术架构
本项目采用本地优先的 Electron 分层架构，代码按运行边界组织：

- **主进程（Main）**：负责窗口生命周期、计时状态机、系统事件和数据库读写，是应用状态的唯一协调者。
- **渲染进程（Renderer）**：负责番茄钟、任务画布、设置等界面；番茄钟使用 PixiJS 渲染，任务画布使用原生 TypeScript 实现。
- **Preload / IPC**：通过 `contextBridge` 暴露类型化的最小 API，渲染进程不直接接触 Node.js 或文件系统。
- **数据层**：使用 sql.js（SQLite WASM）保存任务、计时记录和设置，由主进程统一读写并持久化到本地。

计时器以状态机驱动，状态变化和数据变更通过 IPC 广播到各窗口；窗口之间不共享内部实现，只依赖 preload API。Vite 负责渲染层开发与构建，TypeScript 编译主进程，electron-builder 生成 Windows 安装包。

## 支持项目

[![微信赞赏](https://img.shields.io/badge/微信-扫码赞赏-07C160?logo=wechat&logoColor=white)](static/money-receiving-qr-code.png)

## 许可证

本项目采用 [PolyForm Noncommercial 1.0.0](LICENSE)。

- 允许：个人学习、使用、修改、再分发
- 禁止：任何商业用途（包括销售、收费托管、广告盈利等）
- 分发时需保留版权声明与许可证全文

**素材版权说明**：内置的像素素材、音效与字体文件版权归原作者所有，仅随本项目以非商业目的分发，请勿单独提取用于商业用途。
