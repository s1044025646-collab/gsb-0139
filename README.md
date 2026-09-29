# 天线阵列方向图与波束权重评估后端

Windows 本地可运行的一维线阵评估后端：仅提供 **HTTP API、CLI、合成阵列夹具、自动化测试**。
不包含网页界面、不发射任何射频信号、也不连接真实通信设备。

## 模型与约定

- 阵元：沿 x 轴排列的各向同性点元，远场、一维线阵；**不含互耦，不含真实阵元方向图**（每份报告都带该声明）。
- 角度参考轴：`theta = 0` 为阵法线方向（broadside），`theta = ±90°` 为沿阵轴端射；可见域固定为 `[-90, 90]`。
- 波数 `k = 2π/λ`，阵因子（相位符号 `+j`）：
  - `AF(θ) = Σₙ wₙ · exp(+j·k·xₙ·sinθ)`
  - 指向 θ₀ 的权重：`wₙ = aₙ · exp(-j·k·xₙ·sinθ₀)`
- 场幅与功率严格区分：场幅 `|AF|`；功率方向图 `|AF|²`；归一化功率 `P = |AF|² / max|AF|²`；
  功率分贝 `dB = 10·log10(P)`（不是 20·log，20·log 仅用于场幅）。
- 主瓣半功率边界用相邻采样点**线性插值**求 `-3 dB`（P=0.5）交点，得到 HPBW。
- 旁瓣查找规则：只接受**严格高于两侧邻居的内部局部极大值**，且必须落在闭合主瓣区间
  `[hpbw_left, hpbw_right]` 之外；主峰相邻采样点永远不会被当成旁瓣。
- 必须显式标记、不得强行给出唯一指向的情形：
  - 栅瓣（可见域内出现与主峰等强的第二个内部极大，二次插值精修位置与高度）；
  - 多个同高主峰 / 端射边界混叠（`multiple_equal_peaks`，`unique_peak=false`）；
  - 全零权重（`all_zero_weights`，无方向图）；
  - 主瓣在 ±90° 或网格边界处未闭合（`main_lobe_incomplete`，HPBW=null）。
- 角度网格可任意加密；加密后 HPBW 估计单调收敛（测试中比较粗/中/细网格）。

## 依赖

- Node.js `>= 22.5`（开发验证于 Node 25，使用内置 `node:sqlite` 与原生 TypeScript 运行，**无需原生编译**）。
- 仅开发依赖：`typescript`、`@types/node`。

```powershell
npm install
```

## 测试

```powershell
npm test
```

覆盖：解析小例（双元相位叠加/对消、broadside 偶对称、整体缩放不变性、峰位、加窗 SLL/HPBW、
栅瓣、端射边界、全零、网格加密、量化误差、10log 口径）、失败路径、事务回滚、幂等、版本链、
重启持久化、HTTP API 全链路、CLI 端到端演示。所有临时文件都在项目内 `.tmp/`。

类型检查（可选）：

```powershell
npm run typecheck
```

## 启动 / 停止 API

```powershell
npm start
```

- 服务器**只绑定 `127.0.0.1`**，端口传 `0` 由系统自动分配；启动时打印一行 JSON，例如
  `{"host":"127.0.0.1","port":53124,"db":"E:\\...\\data\\array.db","pid":12345}`。
- SQLite 数据库默认 `data/array.db`，可用环境变量 `ARRAY_DB_PATH` 覆盖；启动时执行可重复迁移（IF NOT EXISTS + `schema_migrations`）。
- 停止：在启动该服务的终端按 `Ctrl+C`（SIGINT）即优雅关闭。**启动/停止只管理本项目自身进程。**

健康检查：`GET /health`；约定说明：`GET /conventions`。

### API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/arrays` | 建阵列（`count`+`spacing` 或显式 `positions`，可选复数 `weights`、`idempotency_key`） |
| GET | `/arrays?limit=&offset=` | 分页列出配置 |
| GET | `/arrays/:id` | 取单个配置（含版本链信息） |
| POST | `/arrays/:id/steer` | 生成指向新权重版本（`steer_angle_deg`，`taper=uniform|hann|hamming`） |
| POST | `/arrays/:id/quantize` | 施加幅度/相位量化，返回复权重误差（`amp_bits`/`phase_bits`） |
| POST | `/arrays/:id/disable` | 单个阵元失效 → 新配置（基准权重不改写） |
| POST/GET | `/arrays/:id/scan` | 扫描方向图并持久化报告（`start_deg/stop_deg/step_deg`） |
| GET | `/arrays/:id/data` | 逐角度数据导出（分页） |
| GET | `/arrays/:id/reports` | 该配置的历史报告（分页） |
| POST | `/compare` | 两配置同网格比较（峰位、HPBW、SLL 差值、量化误差） |

错误统一为 `{"error":{"code","message","details"}}`，错误码包括 `VALIDATION_ERROR`、`BAD_GRID`、
`NOT_FOUND(404)`、`CONFLICT`、`IDEMPOTENCY_MISMATCH(409)`、`ELEMENT_OUT_OF_RANGE`、
`DUPLICATE_POSITION`、`ALL_ZERO_WEIGHTS`、`INVALID_PAGINATION`。
重复提交携带同一 `idempotency_key` 时返回同一行，不产生重复版本；键被不同负载复用返回 409。

## CLI

```powershell
npm run cli -- create --name ULA8 --wavelength 0.1 --count 8 --spacing 0.05
npm run cli -- list
npm run cli -- steer --id 1 --angle 30 --taper hann
npm run cli -- quantize --id 2 --phase-bits 3
npm run cli -- disable --id 2 --element 3
npm run cli -- scan --id 2 --step 0.5
npm run cli -- compare --a 1 --b 4 --step 0.5
npm run cli -- export --id 2 --out data/pattern.csv --step 0.5
```

写操作打印 `BEFORE/AFTER` 状态；阵元失效只生成新配置，基准版本保持不变。数据默认在 `./data/`，
可加 `--db <path>` 改到项目内其他位置。导出 CSV 列为
`angle_deg,af_re,af_im,field,power_norm,power_db`。

## 可重复演示

```powershell
npm run demo
```

使用固定时钟、固定网格与项目内 `data/demo.db`（每次运行先删除重建），跑全部合成夹具
（单阵元 / 双元 / 半波距 ULA / Hann 加窗 / 超半波距栅瓣 / 端射边缘 / 全零）并演示版本工作流。

## 数据与清理

- 所有数据库、CSV、临时目录均位于项目内：`data/`（运行数据）、`.tmp/`（测试临时目录）。
- 清理：删除 `data/` 与 `.tmp/` 即可；迁移可重复执行，重新启动不丢历史版本。
