# Android 可靠性验收记录 — 2026-09-08

## 范围与状态

本轮处理通知恢复及品牌图标、双向图片传输副本 ≤1,000,000 bytes、单次用户消息重复。**v0.5.32 已于 9 月 9 日公开发布**，全部正式资产重新下载核验完成，正式 Mac 包已按现有更新器安装并恢复 Gateway / Desktop 桥接。此前未完成的原生复验仍保留为未验收，不因发布改标通过；下文早期记录按发生顺序保留。

验收分层：源码测试、HTTP/原生测试夹具、实际模拟器页面操作、正式签名与公开资产分别记录。模拟器通过不能证明所有手机 VPN、蜂窝网络和 OEM 后台策略均通过。

## 已完成

- 通知行为提交 `0afc4d8`：完整检查 64 文件 / 912 测试通过；Web E2E 57 通过 / 9 既有平台跳过；Java 21 项通过。
- 品牌提交 `d9286d6`：标准通知模板复用 Launcher 大图标；单色小图标从同一素材生成。任务审查没有 Critical / Important。
- Android debug 模拟器原生通知测试 `OK (1 test)`，51.963 秒。断言完成、运行、常驻通知的大图像素与小图轮廓。实际锁屏看到了黑底完整品牌图标；Android 隐藏静默锁屏通知的系统设置保持不改。
- 通知权限关闭提示、设置跳转、权限恢复提示消失已经实际点击。清理诊断输出后的 instrumentation 已重跑通过；最终整包仍需复验，并点击一次完成通知核验深链。
- 正式 v0.5.31 APK 重新验签通过，与仓库固定证书相同。未知来源 / Play Protect 提示不等于缺少 APK 签名；未关闭安全防护或更换签名。

## 实际页面基线

- 保留 Android 既有本机连接，从连接页点击进入，连接成功。
- 通过原生页面创建独立 R32 验收会话，第一条纯文本和 `R32-BASELINE-OK` 最终回复各显示一次。
- 通过 Android 文件选择器选中既有 684,915-byte PNG 并发送。原生 finish 到 HTTP 201 约 274 ms，最终 `R32-SMALL-OK` 和图片可见。
- iPhone 通过既有本机连接搜索并打开同一 R32，会话中的 Android 图片和最终 `R32-SMALL-OK` 可见。
- Android 实际发送两次等待的多阶段回答，再点击排队与转为引导。页面显示 `R32-BEGIN`、`R32-MIDDLE`、一条引导消息及最终 `QUEUE32-OK`；原要求的 `R32-END` 被用户引导替换，不误记为最终文本丢失。
- 对 R32 做有界本机记录与 Gateway 历史核对：最初两组 QA 的用户/最终正文及 ID 全部对应，图片 GET 684,915 bytes。新增第三组同时记录实时身份，发现 live 与落盘 UUID 不同，不能按 `msg_` 前缀猜测合并。
- 上述两项使用旧 0.5.31 Gateway，不是新图片压缩验收。用户截图中的超时只定位至原生网络阶段，尚无实际手机日志证明具体网络原因。
- 排查发现 Capacitor debug 默认详细桥日志含请求参数；新增不记录桥参数的配置门禁，覆盖 QA 构建，正式构建原本默认关闭。后续日志采集只保留白名单状态、阶段和字节数，不保存原始参数。
- 日志保护提交 `dd7be1e`：配置断言先红（未设置），修复后 installer 合约 28/28 通过。测试包含刻意模拟 DMG busy 的既有重试日志，不是本轮实际构建失败。
- 真实高熵 PNG（2200×1400、9,244,288 bytes）已加入 Android Downloads 与 iPhone Photos，候选压缩路径联调结果见下一节。

## 图片候选原生验收

- 图片实现 `93347e4` + 0.5.32 版本候选：iPhone 从系统照片库选择上述原图，实际上传并读取为 962,631-byte JPEG；Android 无刷新显示图片与 `R32-IOS-LARGE-OK` 最终回复。
- Android 从系统 Downloads 选择同一原图，实际上传并读取为 915,226-byte JPEG；页面用户消息和最终 `R32-A` 各显示一次。操作工具发生逐字输入延迟与一次粘贴超时，最终按提交后的可见文字及落盘文字核对，不把这次输入工具故障算作 App 发送故障。
- 两次请求分别在有界历史页与原始 QA 记录找到同一组用户/最终文本，图片认证 GET 均 200；较旧 turn 被分页预算排除时保留 `hasMoreBefore=true`，没有宣称一页覆盖整个会话。
- 当前 Gateway 仍为正式 0.5.31，所以这些结果证明新原生客户端上传压缩，不代替新 Gateway 历史大图下载压缩的联调。
- 当前候选 Android instrumentation 重跑：5/5 通过（文件选择参数 3、通知投递与品牌 1、运行环境 1），4.536 秒。图片像素预算审查修正及最终整包仍待复验。
- macOS 本地候选构建和静态签名校验成功，但执行自检被 AMFI 拒绝（adhoc/unknown chain，退出 137）。未更改系统安全设置、未替换正式 App；继续通过既有分支候选流水线准备可核验包，不把构建当安装通过。
- iPhone 也在未刷新情况下显示 Android 发来的大图及最终回复，两个方向均已实际查看。
- 首轮分支候选流水线的检查因 2 GB V8 heap 耗尽失败，构建和发布均未执行。相同 2 GB 条件下单文件已复现：9.24 MB Buffer 的深度对象比较枚举大量键；改用字节相等检查后须在原内存限制下复验，不提高限制掩盖原因。
- 本机随后锁屏，真实点击验收暂停，未绕过系统锁屏。通知点击深链及最终整包重连复验保持未完成。

## 独立复审结论

- 图片：`fb55f3a` 已补预览/解码前 32M 像素预算、Canvas 串行及关闭竞态；`651a38e` 已补共享 5 秒读头超时、abort 与清理，20 秒压缩总期限不重置。独立复审全部通过，最终原生整包仍待验收。
- 消息：`0be3cf6` 已补精确身份双向唯一预留以及同批 canonical 数据/顺序合并。10 个原始反例先红后绿，另补 2 个歧义保护反例；独立复审额外 85 个固定源码断言通过，最终原生整包仍待验收。
- 通知：`1b95bc8` 将同轮失败保持规则同时用于 completion 与 live 状态，防止 systemError 后泛化 completed 误报成功。新增 5 个接口回归、7 组独立固定函数 probe 通过；新增原生失败标题/重播断言只编译，尚未运行。
- 通知非阻塞边界：Gateway 保留最近 100 条完成元数据，原生保留最近 200 个已见身份，不承诺无限历史去重。独立复核未找到自动重放远古完成事件的生产入口，不新增推测的游标或 UUID 时间规则。极端持续慢响应尚无整个请求的截止时间，连接/单次读取超时和响应体上限仍有效，记录为后续网络健壮性项。

## 最终集成检查

- 冻结源码 `1b95bc8`：本地 Node 24.19.0、pnpm 11.19.0，以与 CI 相同的 2 GB heap / 单 worker 条件执行完整检查，68 文件 / 1001 项通过，93.59 秒。GitHub 工作流使用 pnpm 10；尚未重跑新提交的远端候选流水线，不把本地测试等同远端 CI 成功。
- Java 单测显式 `--rerun`，21 项实际重跑通过，不以 Gradle up-to-date 作为重新执行证据。
- 首次整套 Web：59 通过、2 失败、9 个既有跳过。Trace 确认旧测试在读头未完成时对 disabled Steer 使用 dispatchEvent，图片名尚未出现时 count=0 假通过，两个项目都只有首图 1 次 POST。`dfc69ba` 仅修正等待预览可见、按钮可用后正常点击；两张图片及刷新后数量断言保持。定向 2/2 通过，完整重跑 **61 通过 / 9 个既有跳过 / 0 失败**，52.2 秒。
- `181310d..dfc69ba` 全分支独立审查：源码 Spec / Quality PASS，Critical 0 / Important 0；另有 69 个固定源码断言通过。上述已知通知慢响应 Minor 保留，不伪称无限网络条件均已证明。
- Android debug APK / androidTest APK 构建成功；iPhone Release Simulator 构建成功，ZIP 完整性与本地模拟器签名校验通过。新原生测试已编译，未执行。
- 候选源提交 `dfc69ba`：Android versionName 0.5.32 / versionCode 41，iOS 0.5.32 / build 39。两个包内全部 7 个 Web 资源与 dist 逐字节一致，Capacitor loggingBehavior 均为 none。
- Android 候选是 Debug QA 包，v2 验签通过，不是可覆盖正式安装的发布 APK；未改变固定发布证书或将 Debug 包作为正式产物。正式签名 APK 仍须由后续发布流水线生成。
- 22:43 复查仍被 Mac 锁屏门禁阻挡；未安装最终新包、未执行新 instrumentation 或绕过安全控制。

### 构建校验记录

内部 QA 资料保存在 ignored 的 `artifacts/native-acceptance-20260908/`，未包含运行凭据或原始桥参数。

- Android debug APK SHA-256：`bf0bed40f68a91900bfe9f0506debf485fd500f5942595f3dd0a174461867d08`。
- iOS Simulator ZIP SHA-256：`b17bf6e311016b4bf999996e408beb29457a71dc4dd17b2252e4a56f30c595b0`。
- 共用主 JS SHA-256：`f8f862ef5f47c58e63eb2405b5ca601dea63124f5929af6b203e2e012442cab0`。
- `r32-final-bundles.json` 与 `verify-final-bundles.mjs` 记录、复查包内资源一致性；这些是构建静态证据，不是安装或页面验收。

## 待完成门禁

### 2026-09-09 解锁后续验

- 用户解锁后，Computer Use 已重新取得 Android / iPhone 模拟器页面；未绕过锁屏或修改系统安全设置。
- 源码与远端验收分支均为 `17e3734`（相比候选源 `dfc69ba` 仅增加文档）。最终 Android 0.5.32 / 41 与 iPhone 0.5.32 / 39 已覆盖安装，保留既有本机连接；安装前重新核对包内全部 Web 资源、关闭桥参数日志和包校验和。
- 最终 Android instrumentation **5/5 通过，8.126 秒**，包含新增同轮失败通知标题与重播去重断言；不是沿用较早候选的原生结果。
- 两端实际点击进入 R32 会话，均恢复 Android / iPhone 发出的压缩大图及其最终回复；Android 图片点击预览、关闭与上翻多工具轮次正常。此时 Mac Gateway 仍为 0.5.31，新 Gateway 跨端验收保持待完成。
- 当前提交的 [GitHub 分支候选构建 34302456805](https://github.com/cnwenf/codex-remote/actions/runs/34302456805) 已完整成功：verify、Mac ARM64 / x86_64、正式签名 Android、iOS 构建成功；publish 按分支构建规则跳过。正式标签与公开发布尚未执行。
- 通过 GitHub 附件接口重新下载本次 Mac ARM64 候选；ZIP SHA-256 与流水线 digest 一致（`5179207fc9c93468fa2f542cf5493b7ff2ddfc360cca3b9eb2bd6212d4d508a5`），DMG 内附校验和、hdiutil verify、codesign 静态校验均通过。
- 10:22 本机直接执行这份 CI 候选的 `--self-test`，退出 137。amfid 明确返回 `AppleMobileFileIntegrityError -423`：临时签名或未知证书链。候选与当前 0.5.31 都为 adhoc 签名，但不能据此推断新候选已获执行授权；未改签、清除安全属性或关闭系统防护。
- 系统设置“隐私与安全性”底部实际未出现本候选的“仍要打开”入口；本机有效代码签名身份为 0。需要用户/管理员通过正常安装授权流程处理或提供受信任开发者签名，不能以替换安装再试作为绕过手段。正式 App / Gateway 仍为原来的 0.5.31，未重启 Codex Desktop。
- iPhone 已恢复图片和最终回复，但本轮 scroll/drag 操作未观察到上翻位置变化；未将完整上翻验收标为通过，待恢复候选联调后区分原生手势操作与页面行为。

### 安装流程复核与更正

- 用户指出此前已要求参考本地一键安装代码。补读根目录 `install.sh` 和 `UpdateSupport.swift`，确认正常流程是校验 DMG、复制到安装目录，再启动已安装 App；不以执行挂载目录的二进制作为安装前置条件。此前把 DMG 内 `--self-test` 被拒绝直接判断为必须人工授权，结论过度，予以更正。
- 对同一个已核验 CI 候选，未改签、未清除属性、未改变安全配置。复用原有 `perform-macos-update.sh`，在专用临时目录暂存并校验，通过精确 PID 只停止旧 Remote / Gateway，更新器完成复制与启动就绪校验，退出 0。
- 更新器启动的 App 在命令结束后未保持运行；使用安装器已有的 `local.codex-remote.app` LaunchAgent 正常启动后，App PID 20836 / Gateway PID 20847 持续运行。管理页实际显示 Version 0.5.32、Desktop bridge Connected；`/health` 200，已安装包自检通过。
- Desktop PID 18611 始终不变；配置与 token 文件的 inode、大小、修改时间均未变化。旧包由原有更新器在成功后清理，正式 0.5.31 发布资产仍可用于回退。没有执行会重写连接、输出密码并重新注册 Desktop 的全量初装脚本。
- 因此 Mac 正常安装阻塞已解除，不能继续沿用上节的“等待人工执行授权”作为当前结论。

### 0.5.32 已安装版本跨端复验

- Android 连续两次实际发送同一句 `Reply only REPEAT32-OK. No tools.`；Android、iPhone、Web 均保留两组 QA，每组各一条用户消息和最终回复。有界原始 session 与 Gateway 历史页确认两个不同 turn / user ID，未按正文误合并。
- iPhone 系统照片选择器发送 9,244,288-byte 高熵 PNG：新 Gateway 实际 GET 962,631-byte JPEG；Android 无刷新显示图片和最终 `R32-IOS-FINAL-OK`，图片预览可打开、关闭。
- Android 系统 Downloads 选择相同原图：实际 GET 915,226-byte JPEG；iPhone 无刷新显示图片和最终 `R32-ANDROID-FINAL-OK`，图片预览可打开、关闭。两端源记录均只有一次用户提交。
- 实际 Web 页面选择同一原图：实际 GET 912,912-byte JPEG；两端接收图片与最终 `R32-WEB-FINAL-OK`。新建页面保留既有登录，不更改连接密码。
- 已安装 Gateway 兼容旧客户端的 9,244,288-byte 原始上传后，实际图片 GET 返回 828,450-byte JPEG，用时 613 ms；上传目录原文件 SHA-256 与输入完全一致。此为实际进程接口验证，不冒充原生上传压缩。
- Web 发起 45 秒工具等待，排队一条与上一轮同文、同图消息，再在 Android 实际点击“转为引导”。Web / Android 显示 `R32-RUNNING`、完成的工具组、一条带图引导消息及最终 `R32-WEB-FINAL-OK`；未要求被引导替换的 `R32-FINISHED` 继续出现。
- Android 通知栏实际收到 R32 完成通知，展开后点击回到正确的 R32 会话及最新图片 / 最终回复；同时看到运行通知使用黑底完整品牌大图。Android 标准分组模板可能只展示小图标，不能把系统模板的裁切/折叠承诺为完全自定义布局。
- 重新下载分支 CI 的正式签名 APK，ZIP digest 与 GitHub 一致；固定发布证书验签通过，未使用 Debug 签名替代公开 APK。
- 新图片最终回复刚到达时观察到短暂“未找到对应的原始问题”，随后无刷新恢复；只读索引核验 question / anchor 对应正确。此为仍需评估的短暂提示体验，不是 QA 内容丢失。
- 精确停止已确认的 Gateway 子进程后，原生 App 自动拉起新 Gateway；`/health` 恢复 200，Web 自动重连，原有 QA / 图片 / 引导消息不重复，Desktop 与 Remote App PID 不变。
- 11:30 左右 Mac 再次自动锁屏，Computer Use 明确拒绝继续访问原生 UI。尚未完成此次中断后的 Android / iPhone 页面复核和 iPhone 上翻手势确认；不通过其他 UI 通道绕过锁屏，也不把已安装成功误写为安装授权失败。公开发布仍未执行。

- [x] 压缩：高熵大图在 Web / Android / iPhone 上传后 ≤1 MB；Gateway 历史图片 GET ≤1 MB；原图字节不变。
- [ ] 消息：一次发送、连续同文、带图同文、排队、引导、重连，按实际 QA 对照。
- [ ] 通知：最终包 instrumentation、运行 / 完成通知、锁屏品牌与点击跳转。
- [x] 最终全量检查、Web E2E、Android 单测、独立全分支审查。
- [x] 最终 Android 原生整包 instrumentation。
- [ ] 最终候选跨端真实点击验收。
- [ ] 候选 Mac / Android / iPhone 对齐，正式 CI、签名、校验和、发布与安装复验。

本轮双向图片、同文发送、跨端排队转引导、通知点击深链已实际通过，不重复作为未测项。随后用户在已知剩余原生复验未完成的说明之后明确要求“发版”，按该最新指令发布当前已验证候选；上述未完成项和原问题短暂提示写入发布说明，不将其改标为通过。发布流程仍要求完整检查及正式资产校验，不改变系统安全策略。

## 正式发布核验 — 2026-09-09

- [v0.5.32](https://github.com/cnwenf/codex-remote/releases/tag/v0.5.32) 于北京时间 12:35 公开发布，非草稿；标签固定在 `35dcab39c6470813408aa5ca1d4d04fc43846962`。本次发布提交仅补发布说明及验收状态，生产源码与冻结候选一致。
- [正式流水线 34311177969](https://github.com/cnwenf/codex-remote/actions/runs/34311177969) 的 verify、Android、Mac ARM64、Mac x86_64、iOS 和 publish 全部成功。合入 main 后本地完整检查再次通过：68 文件 / 1001 项，99.15 秒。
- 五个正式二进制、各自 SHA-256 文件和 `latest.json` 共 11 项资产全部重新下载。逐项哈希核对、两个 DMG 的 `hdiutil verify`、三个移动归档完整性均通过；五项二进制摘要见下表。
- 两种 Mac App 的深度严格签名校验和 App / Node / cloudflared 架构检查通过。Intel 包挂载后自检通过；ARM64 挂载路径直接自检退出 137，按正常更新流程安装后自检通过，不能将挂载执行结果等同安装失败。未改签、清除安全属性或调整安全设置。
- 正式 Android APK 沿用固定证书，验证通过；版本 0.5.32 / 41。iOS 模拟器包签名验证通过，模拟器与未签名实体 IPA 均为 0.5.32 / 39；实体 IPA 仍需开发者签名。
- 正式 Android / iOS 两种包各自 7 个 Web 资源逐字节匹配 dist，原生桥日志配置均为 none；Mac 两种架构与本机安装的 Web / Gateway 内容一致。
- GitHub latest、raw 备用地址、CDN 清单均为 0.5.32，Android 下载固定提交 `8c743d1758915be46b6654e695a3964d33c537e3`。独立下载 CDN APK 与 GitHub 正式 APK 的字节摘要完全相同。
- 复用 `perform-macos-update.sh` 安装正式 ARM64 包，退出 0；安装目录全部文件与正式 DMG 逐字节一致。通过既有 `local.codex-remote.app` 启动后，`/health` 200，桥接接口返回 `available=true`、`readOnly=false`、`transport=desktop-live`。
- 配置与 token 文件的 inode / 大小 / 修改时间未变，Desktop PID 未变。正式包替换仅停止旧 Remote / Gateway，未重启 Desktop；临时 DMG 挂载均已卸载。
- 本次正式发布没有补做锁屏后的原生点击，因此 iPhone 完整历史上翻及最终中断后的两端原生复验仍未确认，详见发布说明。

| 正式资产 | SHA-256 |
| --- | --- |
| Android ARM64 APK | `a630141af990f64fd2c1346b38abde465e75ddf10aefe29980dbe3741b4cf7e6` |
| Mac ARM64 DMG | `d566b4e3bdc26dbba01fec341e3c941c25678dde73f7afc7d7eb2360896c4ee5` |
| Mac x86_64 DMG | `7f5aea42df16761e99a6fce58bb32b0457afca9c4844435cc48a9b4521fb5003` |
| iOS Simulator ZIP | `46f2e7ca48a12e9e3b104def03711c7b3ca4b5cc82c12005fb3f5ac670b9c637` |
| iOS unsigned IPA | `d616681325606981c0b30d9f410b25f3bfa846f2f34cb402353ad29f2a13b82c` |

## 本轮验收矩阵

此表定义需要证明的行为，不把未运行项标为通过。自动化与实际原生操作互相补充，不用浏览器模拟尺寸冒充 Android / iPhone 原生。

| 类别 | 场景 | 预期 |
| --- | --- | --- |
| 图片 | 小于 1 MB 的原图 | 保持字节，无多余重编码 |
| 图片 | 9.24 MB 高熵 PNG，桌面/移动 Web | POST、GET 实际体积均 ≤1,000,000 bytes |
| 图片 | Android 系统文件选择器大图 | 压缩后原生上传成功；本机落盘与客户端同一条消息 |
| 图片 | iPhone 照片选择器大图 | 压缩后发送成功；Android 无刷新看到图片与最终回复 |
| 图片 | 既有 Desktop / 历史大图 | 按需下载副本 ≤1 MB，原文件字节保持 |
| 图片 | 透明 PNG、带 EXIF 方向 JPEG | 白底明确、宽高比例与方向正确 |
| 图片 | 大动图 | 明确提示静态传输副本，不伪称保留动画 |
| 图片 | 非支持格式、损坏图、选择超限 | 明确失败，不调用上传，不回退超限原图 |
| 图片 | 解码/编码超时、网络超时 | 有界结束、保留可重试草稿、不自动重复提交 turn |
| 图片 | 下载提前断开、文件读取失败 | 流关闭后释放副本，不泄露租约或崩溃 |
| 图片 | 相同图片并发、并发/队列/缓存满、重启残留 | singleflight、有界资源、在用文件不被删除 |
| 消息 | 一次 start 的 optimistic/live/history 顺序变化 | 仅一条用户消息，正文和图片不丢 |
| 消息 | 两次真实同文、同文不同图片 | 两条都保留，图片不串消息 |
| 消息 | 多工具 commentary → tool → final | 中间文本、工具和最终文本顺序完整 |
| 消息 | queue → promotion、queue → steer | 队列确认一次，不重复、不吞后续同文 |
| 消息 | snapshot/prepend/append、重连重放 | 保留已确认身份关联及历史位置 |
| 消息 | 跨 turn 相同 item ID、冲突 client ID、分页不完整 | 不跨轮猜配、不按全文去重 |
| 通知 | 权限关闭/恢复、渠道关闭、监控失败/恢复 | 状态提示准确，可进入系统设置与重试 |
| 通知 | 短轮次跳过轮询、已观察 running→completed | 完成通知不漏发、不重复 |
| 通知 | 冷启动已有历史、旧事件迟到、新 turn | 不补发一堆旧消息，不吞新完成 |
| 通知 | 运行/完成/常驻、下拉栏、锁屏与深链 | 同源品牌图形；点击进入对应会话 |
| 发布 | 版本号、固定证书、全部资产与校验和 | 可覆盖升级，公开下载指向同一新版本 |
