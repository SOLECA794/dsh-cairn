# dsh-cairn

cairn（石堆路标）是每个过路人往上添一块石头，让后来者能找到路。这个插件为
[dsh](https://github.com/deepseek-ai/deepseek-harness) 的编码会话做同样的事：把
**「这次改动到底验证过没有」**变成一个可查询的事实，而不是模型对自己的陈述。

已验证：**169 个单元测试**、**24 项 `apply()` 冒烟检查**（对着 mock context 跑），
并在真实仓库上做过一次 dry run。

## 要解决的问题

会话里最廉价的一句假话，是那句笃定的「搞定了」。它没有任何成本，也没人核对：

- 模型改了四个文件，跑了它记得的那一个检查，然后报告成功。第五个文件是在检查**之后**
  写的，没人发现 —— 因为「测试过了吗」问的是整个会话，不是那个文件。
- 第 3 轮有个检查挂了，模型继续往下做，到第 9 轮它报告了一个通过的构建 —— 而会话里最后
  跑的东西是红的。
- 仓库在 `AGENTS.md` 里写着「动了 kernel 就跑回归」。没有任何东西在兑现这句散文。

这些都不是「上下文再长一点就能记住」的问题，而是缺一个代数：**哪些写入被哪个检查真正覆盖了？**
这件事是可计算的，也就是这个插件的全部。

## 它做什么

| 接缝 | 行为 | 成本 |
|---|---|---|
| `.cairn/verify.json` | 项目用数据声明自己的检查 —— `test`、`build`、`typecheck`、`lint`，外加 glob 路由 | 免费 |
| 账本 | 记录每次写入、读取、验证与被拦下的命令，并按**时间戳**把验证归属到它覆盖的写入上 | 免费 |
| 提醒 | **只在有东西未验证时**注入一段 `<cairn>`，点名文件与声明的命令 | 几百字符，按需 |
| 闸门 | 可选地在依据不足时拒绝 `present` / `git commit`，并附上理由 | 免费 |
| 信息素 | 跨会话存活、会衰减的按路径信号：*这个文件脆*、*这是入口* | 免费 |

它不省任何 token。它每次注入花掉几百字符，换来「未经验证的完成」概率更低。
`gate.mode: 'off'` 可以停掉这笔开销而保留记账。

### 它从不执行任何东西

`lib/verify.js` 从仓库内容里读出一张「glob → 命令」的映射表。这离供应链漏洞只有一次
`spawn()` 的距离：clone 一个仓库、打开它、然后仓库就在跑代码。所以本插件根本不执行命令。
那些声明出来的字符串只是**提醒** —— 这个 harness 里唯一的执行者是 shell 工具，带着用户的
权限预设。那套设计所需要的信任闸门在这里不存在，因为它所守护的能力也不存在。

第二处刻意的取舍：配置只认项目根目录下的 `.cairn/verify.json`，没有 `~` 回退。一条路由的
含义是「这个仓库要跑这个检查」；从 `~` 继承会让同一个工作树在两台机器上表现不同。

## 安装

```sh
dsh plugin --profile <name> add dsh-cairn
```

装完重启 DSH。不需要任何配置；`cordis.patch.yml` 里每个开关都是可选的，那个文件只是把默认值
写出来给人看。

然后声明你的项目跑什么。没有 `.cairn/verify.json` 也能用 —— 插件照样记账，并照样告诉你
「这个项目没有为这些路径声明检查」：

```json
{
  "test": "cargo test",
  "build": "make build",
  "routes": [
    { "match": "src/kernel/**", "run": "bash tools/regress-rv64.sh", "note": "RISC-V 启动测试" },
    { "match": "docs/**", "run": null }
  ]
}
```

路由按 glob 匹配改动过的文件；每个路径取第一条命中的，重复项去重；配置只要有任何一处坏掉，
就降级为「没有声明路由」，绝不会让一轮对话失败。声明的命令必须是单行、500 字符以内 ——
它会被原样渲染给模型，一个换行符就能让它伪装成第二条指令。

## 提醒长什么样

只在有话可说时才触发。完全验证过的会话拿到空字符串，零 token 成本。

```
<cairn>
VERIFICATION FAILED after the last write to src/net.rs (`cargo test`)
Do not report this work as done. Fix the failure or report it as failing.
2 changed file(s) have no verification after their last write: src/dns.rs, src/tls.rs
Declared checks for these paths (from .cairn/verify.json):
- `src/**/*.rs` → `cargo test`
</cairn>
```

三条规则决定这段文字，三条都在 `tests/remind.test.js` 里被断言：

1. **只点名文件与命令，从不劝行为。** 「建议你验证一下改动」比什么都不说更糟 ——
   它训练模型去略过一条从不携带信息的提醒。这里的每一行要么是路径，要么是命令。
2. **失败优先于遗漏。** `failed` > `unverified` > `blocked` > `verified`，且 `blocked`
   永远不会掩盖未验证的文件 ——「工具链没装」不是通过。
3. **吃不上就说吃不上。** 检查跑不起来时，提醒会明说，并要求把这当成阻塞上报，
   而不是让沉默被读成成功。

## 账本为什么按时间戳归属

最直觉的实现是计数：*12 次写入、9 次验证，看着不错。* 它在唯一要紧的场景里是错的。
一次在文件最后一次编辑**之前**跑的检查，对那次编辑没有任何证明力。所以 `attribute()`
给每个文件挑的是「在其最后写入之后（含）」最新的一条覆盖它的验证：

```
写 a.rs → 写 b.rs → cargo test（通过）→ 编辑 a.rs
                      ↑ 覆盖两者         ↑ a.rs 重新变成未验证；b.rs 仍是 passed
```

没有 `files` 列表的验证是全局的 —— 它覆盖它之前的所有写入，也就是 `make build` 的情形；
带 `files` 列表的只覆盖列出的那些。而一个**比例**会把上面这个情形算成「83% 已验证」，
然后就这样发出去了。账本报的是 `1 of 6` —— 因为问题从来不是「验证了多少」，
而是「还有没有未验证的」。

## 信息素：有半衰期的记忆

跨会话状态是一种负债，它比写下它的理由活得更久。所以信号会衰减，而且只在被重新观察到时才增强：

| 信号 | 半衰期 | 何时写入 |
|---|---|---|
| `fragile` | 7 天 | 该文件写入后检查失败，或单会话内被写 `fragileWrites` 次 |
| `dead-end` | 7 天 | 某条路探索后被放弃 |
| `well-tested` | 14 天 | 一次通过的检查覆盖了它 |
| `refactor-candidate` | 14 天 | 显式标注 |
| `coupling-hub` | 21 天 | 调用者很多 |
| `performance-critical` | 30 天 | 显式标注 |
| `entry-point` | 30 天 | 单会话内被读 `entryPointReads` 次 |

增强是加法、上限 1（`min(1, decayed + added)`），并且会重置时钟 —— 所以反复出问题的文件会
向 1 爬升，而一个月前的一次性信号会淡出，低于 0.05 后被清理。存储上限 200 条，淘汰的是
**最弱的**，不是最旧的。

信号存放在 `$DSH_HOME/storages/dsh-cairn/signals-<项目根哈希>.json`，因此两个项目不会互相继承
对方的意见。它们只是建议：提醒里写着「先验证再相信」，而闸门读的是账本，不是信息素。

## 工具

| 工具 | 回答什么 |
|---|---|
| `cairn_status` | 交付判定：层级、`canDeliver`、理由、按文件的归属、最近的验证、声明的检查。`{verbose: true}` 给全部 |
| `cairn_routes` | 这些文件（或本会话改动过的文件）适用哪条声明的检查。只报告命令，从不执行 |
| `cairn_signal` | `deposit` / `list` / `forget` —— 直接读写跨会话信号 |

## 目录

```
lib/index.js        插件接线：配置、监听器、工具、按 agent 的状态
lib/verify.js       .cairn/verify.json 解析、glob 路由、命令归类
lib/ledger.js       会话内事件日志与按文件的归属
lib/pheromone.js    会衰减的跨会话信号，原子持久化
lib/remind.js       提醒文本与其预算
lib/core.js         路径、glob、原子写入、标签转义
scripts/verify-apply.mjs    没有安装 DSH 也能端到端跑一遍 apply()
scripts/dry-run.mjs         装之前先看看它会对你的仓库说什么
scripts/replay-cairn.mjs    把已发生的会话重放进真实监听器，实测成本
tests/                      每个模块的单元套件（169 个测试）+ 工具桩
```

## 开发

```sh
npm test        # 169 个单元测试，node --test
npm run verify  # 24 项 apply() 检查：注册、闸门、账本、持久化
```

`npm run verify` 用 mock context 驱动真实的 `apply()`，通过模块 hook 把
`@deepseek-ai/dsh-tools` 换成桩，并把 `DSH_HOME` 指向临时目录。它按顺序走完一个会话 ——
写文件、注入提醒、拦下闸门、跑一个失败的检查、跑声明的路由、再编辑、重启 ——
因为这些接缝是有状态的，断掉的环节只有在顺序里才看得见。

### 装之前先在自己项目上试穿

插件全部的产出就是一段条件触发的文本，所以评估它最诚实的方式，是先在你自己仓库上把那段文本读一遍：

```sh
node scripts/dry-run.mjs --root ../my-project --files src/net.rs --command "cargo test" --exit 1
```

它会搭一个 mock context，重放你描述的那个会话 —— 哪些文件改了，以及一条以字符串传入的 shell 结果
（所以什么都不会被执行）—— 然后原样打印出会注入的提醒、它的字符成本、按文件的账本行，
以及闸门会下的判断。指向一个没有 `.cairn/verify.json` 的仓库，就能看到项目什么都没声明时它怎么说。

### 重放一个已经发生过的会话

装插件需要重启 DSH，所以「到底花多少」这个问题从会话日志来回答。下面这条命令把一个真实会话的
事件流灌进插件自己的监听器 —— 日志里没有 `fs/observed`，所以一次 `read`/`write`/`edit` 调用会被
还原成它当时产生的那次观测，每条 shell 结果都交给真正的 `tools/post-execute`：

```sh
node scripts/replay-cairn.mjs ~/.dsh/sessions/<slug>/session-<id>/session.v4.jsonl.zstd
node scripts/replay-cairn.mjs <log> --gate deny    # 数一下它本来会拦下几次交付声明
```

它报出注入了几条提醒、总字符与均值、闸门会拦下什么，以及改动文件按目录的分布。在一个真实的
6 轮内核会话上实测（1,208 次工具调用，其中 1,173 次是 shell/read/write/edit）：**163 条提醒、
146,698 字符、均值 900**，`deny` 闸门会拦下 **1** 次交付声明，而 **163 条里有 121 条（74%）点名的
是某个临时目录下的一次性脚本**，而不是真正在改的源码。

这个数字就是下面 `ignore` 列表的由来。同一个项目声明了四个临时目录 glob 后，同一次重放变成
**120 条提醒、110,860 字符、120 条里 0 条点名临时目录**，文件分布也从临时目录翻回
`kernel-project/src`。

## 配置

每个开关见 [cordis.patch.yml](cordis.patch.yml)，都写着发布的默认值以及为什么是那个值。
真正要紧的三个：

```yaml
gate:
  mode: remind   # remind | deny | off
  tools: [present]
  commands: [git commit, git push]
```

### 忽略临时产物

只要观测到某个文件上有 write 或 edit，账本就把它算作「本次会话改过」。其中有些写入并不是交付物 ——
别的工具拥有的临时目录、构建产物、会话日志。放任不管，它们会挤满只显示六个文件的待验证列表，
被挤掉的恰好是你真正想验证的那部分源码。

所以让项目像声明检查一样，把「什么算临时」也声明成数据，写在同一个文件里：

```json
{
  "test": "cargo test",
  "ignore": [".rivet/**", ".workbuddy/**", "target/**", "log/**"]
}
```

语法和上限与 `routes` 一致：glob 在加载时校验（写错的 glob 是配置错误，不是静默跳过）、去重、
上限 64 条。被忽略的路径仍然会被观测，也仍然能产生信息素信号 —— 它只是永远不会成为「本次会话
改过的文件」，因此既拦不住闸门，也挤不掉真正的工作。

这里刻意不做内置默认值、也不读 `.gitignore`：cairn 不跑 `git`、不 spawn 任何东西，而一项检查因为
一个你根本不知道存在的文件而悄悄消失，比偶尔吵一点糟糕得多。没声明 `ignore` 的项目，每一次写入
都被计入。

## 许可

Apache-2.0。衍生说明见 [NOTICE](NOTICE)。
