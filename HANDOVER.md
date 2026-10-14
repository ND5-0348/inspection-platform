# 抽检云台：现阶段交接

更新日期：2026-10-09。本文依据当前工作区、运行服务、自动测试及本轮用户手机反馈整理。交接对象是**这台 Windows 电脑上的工作区、MySQL 数据库、照片文件和局域网证书**；仅克隆 Git 仓库不能还原当前状态。

## 一、当前结论

系统已在本机跑通业务流程：创建或导入检测单 → 选择人员派单 → 接单 → 现场货物拍照（无需定位）→ 图片定位签到 → 托盘／箱／件随机抽样 → 逐样品拍照和填写结论 → 提交审核 → 退回重提或审核通过。货物照片为独立的 `GOODS` 证据类型；它不要求 GPS，也不替代带位置水印的签到照片和样品照片。

网页已通过局域网 HTTPS 供同一路由器上的手机访问。用户已确认手机能打开登录页并完成拍照签到。**新增货物拍照功能已通过接口、工作流和 MySQL 回读测试，尚未收到用户真机拍摄反馈。** 当前仍是本机局域网部署，并非公网或正式生产环境。

## 二、工作区和运行快照

| 项目 | 当前值 |
|---|---|
| 项目根目录 | `E:\project\inspection-platform` |
| Git 分支／最后提交 | `main`／`789963a Initial inspection platform implementation` |
| Git 远端 | `https://github.com/ND5-0348/inspection-platform` |
| 代码状态 | 有大量未提交修改及未跟踪文件；不要重置工作区 |
| Node／npm | 24.14.0／11.9.0 |
| 数据库 | 本机 MySQL `localhost:3306`，`inspection_platform_dev` |
| API | `127.0.0.1:3300`，当前 PID 25528 |
| 本机网页 | `http://127.0.0.1:5173/`，当前 PID 7184 |
| 手机连接指引 | `http://192.168.1.10:5173/`，当前 PID 24456 |
| 手机 HTTPS 工作台 | `https://192.168.1.10:8443/`，当前 PID 7828 |

IP 和 PID 是 2026-10-09 的快照，重启或切换 Wi-Fi 后需重新检查。此轮检查 API `/api/v1/health` 返回 `ok`，HTTPS 首页返回 200；API 启动日志显示 `MySQL persistence ready`。当前库从管理员接口可读到 **18 张检测单、4 个任务、0 张正式货物照片**。自动化测试使用隔离数据，不会把测试货物照片写入业务库。

## 三、已实现功能

| 模块 | 当前行为 |
|---|---|
| 身份和人员 | 工号登录、服务端角色权限；管理员新增、重置密码、休假／恢复和停用抽检员 |
| 检测单和导入 | 手工建单、18 列质检周计划 Excel 导入、重复订单跳过及物资行合并 |
| 派单 | 全部符合条件人员随机；指定单人；指定多人范围内按工作量随机；服务端复核资格并记录审计 |
| 接单和抽样 | 抽样员接单；按托盘、箱、件生成不重复且锁定的随机位置 |
| 图片签到 | 网页／小程序拍照、GPS、精度、时间、中文地址和水印；签到证据防重复 |
| 现场货物照片 | 接单后可拍摄，无定位请求；保存为 `GOODS`，任务详情和管理员审核页可预览；提交审核后禁止继续追加，退回后可追加 |
| 逐样品证据 | 每个随机位置至少 1 张、最多 5 张；照片和元数据带位置、坐标、地址和时间 |
| 检测审核 | 逐位置结论；缺签到、样品照片或结论时阻止提交；管理员可退回或通过 |
| 持久化 | MySQL 保存业务和照片元数据；原始照片存本机 `data/uploads`，鉴权接口读取，记录 SHA-256 |
| 局域网 | 同源 HTTPS 网页代理本机 API；HTTP 5173 提供连通指引和 CA 证书下载 |

货物照片接口：`POST /api/v1/tasks/:taskId/goods-evidence`，抽样员鉴权、任务归属校验，只接受 `ACCEPTED`／`IN_PROGRESS`。上传使用 multipart 字段 `evidence`，只接收 JPG、PNG、WebP，单文件上限 10 MB；请求不含经纬度、地址或定位精度。旧的 `INSPECTION` 现场全景照片接口仍在，不能把它与新的 `GOODS` 类型混为一谈。

## 四、手机访问与启动

项目根目录双击 `启动系统.cmd`，或在 PowerShell 中执行：

```powershell
Set-Location 'E:\project\inspection-platform'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\start-lan.ps1
```

脚本读取当前 `WLAN` IPv4、检查证书，并启动缺失的 API、本机网页、局域网 HTTP 指引和 HTTPS 服务。**已有任一项目端口被占用时，脚本会跳过构建**；源码改变后先执行 `npm.cmd run build`，API 源码改变还需核对 3300 端口的命令行并重启该 API 进程，再运行启动脚本。静态网页服务会读取新的 `dist` 文件，通常不必重启。

手机首次连接：先打开 HTTP 指引页，下载 `data/lan-ca.crt`，在手机系统中安装并信任该局域网 CA，然后打开 HTTPS 工作台。定位签到依赖受信任的 HTTPS。防火墙放行由 `修复手机访问.cmd`／`tools/configure-lan-firewall.ps1` 处理，规则限定 WLAN 和本地子网的 5173／8443 TCP。电脑需保持开机，手机与电脑需能互访；Wi-Fi IP 变化后重跑启动脚本更新服务器证书。CA 私钥位于当前 Windows 用户的 `AppData\Local\InspectionPlatform\lan-tls`，不要外传。证书指纹和手机信任步骤见 `README.md`。

日志：`service-api.stdout.log`、`service-api.stderr.log` 及相应的 `service-web-*.log`。出现“页面正常但只看到演示数据”时，先查 API 日志里的 `MySQL persistence ready` 和根目录 `.env`，不要重复导入计划。

## 五、定位地址和证据边界

当前本机 `.env` 使用 `MAP_PROVIDER=osm`：拍照签到及样品留证把 GPS 坐标经后端发往 OpenStreetMap Nominatim，要求中文返回；服务端有缓存与串行限速。地图不可用时保留原始坐标，中文检测单地址可回退，英文订单地址则显示“定位地址暂未解析”。旧签到的网页展示可按已存坐标重新解析中文，但**旧照片中的英文水印不会改写**。高德／百度适配存在，但当前没有配置正式 Key。多人高频或生产使用应选择有配额和服务保障的地图提供方，并核对外部坐标传输的业务要求。

`GOODS` 货物照片不调用定位或地图服务。签到和逐样品照片仍使用定位。水印当前主要由客户端生成，服务端保留元数据和文件哈希；尚未实现服务端重绘／验证水印、原图与水印图双存储或证据变更审批。

## 六、验证记录

- 2026-10-09：`npm.cmd test`，6 个测试文件、29 项通过。
- `npm.cmd run build`：API TypeScript 和网页 TypeScript／Vite 构建通过；小程序相关 JS 经 `node --check` 通过。
- 完整 API 工作流测试覆盖派单、接单、无定位货物照片上传及读取、图片签到、抽样、逐样品照片、保存结果、提交审核、退回重提和通过；确认审核中不能追加货物照片。
- 在临时独立 MySQL 库中验证 `GOODS` 元数据写入与重新加载，确认无经纬度；测试库已清理，业务库未加入测试照片。
- 运行中的 HTTPS 首页返回 200，新版网页 bundle 已由 8443 服务提供；运行中货物照片接口可访问。真机新入口的相机交互仍需现场验收。

复现：

```powershell
Set-Location 'E:\project\inspection-platform'
npm.cmd test
npm.cmd run build
Invoke-RestMethod 'http://127.0.0.1:3300/api/v1/health'
```

## 七、关键文件

| 文件 | 责任 |
|---|---|
| `apps/admin-web/src/App.tsx` | 管理员订单、人员、派单入口和审核页（含货物照片预览） |
| `apps/admin-web/src/DispatchDialog.tsx` | 选择候选人员派发 |
| `apps/admin-web/src/SamplerPortal.tsx` | 抽样员网页流程、货物拍照、签到和样品水印 |
| `apps/admin-web/src/api.ts` | 网页 API 客户端与数据类型 |
| `apps/api/src/routes/api.ts` | 业务接口、上传约束、审核门槛 |
| `apps/api/src/services/map-location.ts` | 中文逆地理编码及回退 |
| `apps/api/src/storage/local-evidence.ts` | 本机照片保存、读取和 SHA-256 |
| `apps/api/src/persistence/mysql-persistence.ts` | MySQL 结构补齐、加载和持久化 |
| `apps/api/src/runtime-config.ts` | 根目录 `.env` 定位 |
| `apps/api/tests/api-flow.test.ts` | 完整工作流回归 |
| `apps/mini-program/pages/inspection/` | 小程序现场流程和货物拍照入口 |
| `tools/start-lan.ps1`／`tools/static-server.mjs` | 局域网服务和 HTTPS 反向代理 |

## 八、未完成工作与接手顺序

1. **保存当前源码状态。** `git status --short` 仍显示大量修改；`HANDOVER.md`、`DispatchDialog.tsx`、`runtime-config.ts`、多项测试和两个局域网脚本仍未跟踪。最后本地提交仍是初版，不要重置或用远端覆盖本机。先审查差异，再提交和同步。
2. **备份业务库、照片和配置。** `.env`、`data/uploads`、局域网 CA 私钥、MySQL 内容不在 Git 中。移机需分别迁移；本轮没有执行正式备份和恢复演练。
3. **真机验收新货物拍照。** 用已接单任务验证拍摄、上传、缩略图、管理员审核页及弱网重试；确认 iPhone／Android 的相机行为。正式业务库当前还没有 `GOODS` 照片。
4. **修正小程序运行配置。** `apps/mini-program/app.js` 仍写着旧的 `http://192.168.1.25/api/v1`，与当前电脑 `192.168.1.10` 和 8443 HTTPS 入口不一致；小程序仍使用演示身份，正式微信登录与人员绑定未完成。
5. **收敛运行配置。** 缺失 MySQL 配置时服务仍可回退内存模式；`local-evidence.ts` 在模块导入时确定照片根路径，需统一配置加载顺序并使用明确的绝对上传路径。当前从项目根目录启动且 `.env` 使用 `data/uploads`，可正常运行。
6. **推进生产能力。** 逐物资独立抽样、任务移交、证据补拍／删除审批、服务端水印校验、云对象存储、数据库与文件备份、监控、正式 HTTPS 域名和公网部署仍待设计及验收。

除非用户明确要求，不要在正式任务或业务库中制造测试订单、测试照片；优先使用隔离测试库和现有自动化测试。
