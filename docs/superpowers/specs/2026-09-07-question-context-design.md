# 回答对应用户问题：服务端定位与移动端置顶

状态：用户已批准聊天中的设计，并授权实现、验收通过后直接发布；无需再次确认执行方式。

## 目标

打开长对话即可看到回答对应的用户问题，不要求客户端加载、渲染或遍历完整 session。保留现有零高度置顶层与展开交互。默认最新回答，上翻时跟随正在阅读的 QA；同一 turn 中追加的输入不能错误覆盖追加前回答的关联。

## 契约与职责

- `src/protocol/question-context.ts`：纯类型、返回值校验与显示文案规则。
- `src/gateway/question-index.ts`：Remote 自有 SQLite 索引、文件身份/增量进度、任务去重、有界异步读取。Desktop SQLite 保持只读。
- `src/gateway/question-records.ts`：只提取记录身份、问题正文片段、图片数量和回答关联，不解码图片或保留工具正文。
- `DesktopState`：复用已有 threadId 查找与 rollout realpath 安全检查，适配问题接口；历史最新页可附带已缓存问题元数据，不等待扫描完成。
- `src/web/state/use-question-context.ts`：按 thread/turn/anchor 请求、短暂 pending 重试、迟到响应隔离及小缓存。
- `ConversationViewport`：识别当前已渲染可见回答定位标识，展示接口返回的对应问题；不根据完整用户消息 DOM 推断问题正文。

RPC 为 `desktopState/readQuestionContext`，请求：

```ts
type QuestionContextRequest = {
  threadId: string;
  turnId: string;
  anchorItemId?: string;
  textOffset?: number;
};
type QuestionContext = {
  threadId: string;
  turnId: string;
  anchorItemId?: string;
  state: 'pending' | 'ready' | 'not_found' | 'error';
  revision: string;
  question?: {
    id: string;
    text: string;
    imageCount: number;
    source: 'user' | 'delegated';
    sourceThreadId?: string;
    truncated: boolean;
    textOffset: number;
    nextTextOffset?: number;
  };
  message?: string;
};
```

无 anchor 时取目标 turn 最新已确认的输入；有 anchor 时取该回答/工具开始前的已确认输入。不能凭文本相同去重。人类输入与严格识别的 delegatedInput 分开标注；自动注入的系统/环境内容不是问题。纯图问题保留 `imageCount`。找不到关联时不回退到别的 turn。

## 大文件约束

- 固定 64 KiB 读块；禁止 `readFile`/`readline` 累积整条 JSONL 或整个 session。
- JSON 单记录可超过 64 MiB；流式跳过不相关字符串，记录提取缓存有硬上限，语法状态有深度/长度上限，损坏记录不能产生伪关联。
- 问题默认返回最多 4096 字符；展开续读也每次最多 4096 字符，明确 `nextTextOffset`，不静默吞字。
- 索引只保留问题摘要/源偏移及 item→question 的小型身份关联；不存回答正文、工具输入结果或 base64。
- 内存缓存按总字节有界（最多 8 MiB），SQLite page cache 同样有上限；不使用随文件长度增长的内存 Map。
- 每个文件只运行一个异步增量任务，全局限制并发读取；在读块间让出事件循环。可用原生 fs 异步读实现，不为后台工作增加 Worker 打包体系。
- 冷文件按需流式建索引，接口立即返回 pending，页面正常显示；已定位的内容可用后自动补齐，不扫描其他未访问会话。
- 记录扫描进度、文件身份与 generation；追加只读增量，半条记录待下次补齐；替换、截断或不符合追加契约的变化使索引失效重建。
- 迟到任务/请求不能提交到新 generation；索引损坏可重建，只处理 Remote 自有索引，不改原 session。

## UI 与刷新

顶部问题栏与现有视觉一致；没有用户消息 DOM 也能展示。源问题已在可见区时避免重复遮挡。按当前可见的 assistant/activity 锚点选择上下文；切换后立刻清掉不相干旧问题，显示定位中。pending 有去重及退避，不为每次像素滚动请求接口；完成/切换/卸载清理计时器。缺失/错误明确显示，不显示无限运行圈、不使用上一轮冒充。展开只读当前问题下一段；问题来源变化时折叠并重置文本分页。键盘与触摸可访问，保持 44px 交互目标，不引入改变内容流高度的置顶循环。

## 验收与发布门禁

1. 尾页仅 final/工具而没有原始用户消息，问题接口和置顶仍正确；同轮超过1000工具。
2. 相同正文不同输入、同轮 steer、排队未确认输入、委派来源、纯图片、多图、长问题分段。
3. 3GiB 以上 session 与巨大单记录；读取/内存不随 session 大小线性增长；主事件循环可响应。
4. append、半条记录、截断、替换、损坏数据、并发请求及跨任务迟到响应。
5. Web desktop/mobile 几何与交互；真实本机历史对照；Android/iPhone 安装后置顶、上翻、展开、跨端新图片、QA正文与工具结果核对。
6. 完整 check/E2E、精确 gateway 中断恢复且 Desktop 不重启；所有本轮已确认阻断性缺陷关闭。
7. 对齐各平台版本，使用未占用新 tag；CI和正式资产下载校验、安装与连接分别取证，不把单个绿色结果称为全部通过。
