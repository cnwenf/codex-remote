# Android 安装与签名

## 正式包是什么

GitHub Release 的 `Codex-Remote-android-arm64.apk` 使用固定发布证书签名，不是 Debug 包。构建缺少签名配置时直接失败，发布流程用 `scripts/verify-android-signing.sh` 校验签名身份，并生成 APK 的 SHA-256 文件。

Android APK 的应用签名与“应用商店已审核”“开发者身份已验证”是不同的事情。有有效签名，不代表系统一定不显示外部来源或安全扫描提示。[Android 应用签名说明](https://developer.android.com/studio/publish/app-signing)

## 遇到不同提示怎么办

| 提示 | 判断与处理 |
| --- | --- |
| 未签名、签名无效、文件损坏 | 重新下载正式 APK；校验文件 SHA-256 和 APK 签名。不要重签下载文件来掩盖损坏。 |
| 与已安装版本签名不一致、无法覆盖安装 | 核对是否安装了调试包、第三方重签包或不同证书的版本；先保留数据，不通过卸载正式应用来解决。 |
| 未知来源、此来源不允许安装 | 属于商店外分发的来源授权，不是 APK 没有签名；具体设置由用户决定。[官方分发说明](https://developer.android.com/distribute/marketing-tools/alternative-distribution) |
| Play Protect 或厂商提示未扫描、未知开发者、风险应用 | 保留完整提示、系统/手机品牌、下载渠道；先确认是否识别为风险或只是缺少信任信息，再走相应渠道的开发者验证、审核或误报申诉。[Play Protect 说明](https://support.google.com/googleplay/answer/2812853?hl=zh-Hans) |

不要把关闭系统安全检查作为产品的常规安装方案，也不要承诺通过重新签名就能消除厂商提示。

## 更接近普通应用的分发方式

面向公开用户，选择目标设备常用的正规应用商店，完成开发者账户验证、应用资料与隐私说明、必要审核及测试，再从商店安装和更新。Google Play 路径需要配置 Play App Signing 和上传已签名 AAB；国内厂商商店按各自的当前要求办理。具体上架门槛需要针对所选商店确认，不能把某一家规则当作所有 Android 的规则。

已有用户升级兼容性必须保留：不随意更换包名或发布证书；采用 Play App Signing 时规划现有签名密钥与跨渠道身份，避免商店包和现有 APK 无法互相覆盖升级。[Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)

开发者验证、应用商店审核、应用签名和安全扫描互不等价；即使完成其中一项，也不保证所有手机完全不再提示。
