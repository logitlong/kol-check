# KOL Check · 财经博主可信度验证

看不懂股票，那就验证说话的人。贴一个 X（推特）财经博主的主页链接，系统会：

1. 读取他最近的帖子（含图片）
2. 让 AI 逐条判断哪些是「对具体标的、有明确方向」的观点，以及这条观点管多久
3. 拿真实历史行情对账：发帖后第一个能成交的价格进场，按他自己说的期限持有，和同期大盘比较
4. 给出 0–100 的可信度评分、逐条对账明细和危险信号（引流、承诺收益、晒收益截图）

支持美股、日股、韩股、港股和加密货币。行情来自 Yahoo Finance（免费）。

> 分数是算法根据公开帖子和公开行情自动估算的，不是对任何人的事实认定，也不构成投资建议。

## 怎么用

打开网站，三步：

1. 展开「我的 Key」，填两个 key（下面有申请方法），点「保存到这台设备」。
2. 贴上博主的 X 主页链接，点「开始验证」。默认抓取他的全部帖子，也可以自定义条数；点旁边的 ⓘ 可以看大概消耗多少积分。
3. 等进度条走完，看评分和逐条对账。手机上切到别的 App 再回来，会自动接着显示。

已经有人分析过的博主会出现在首页，点开直接看报告，不需要任何 key。

## 需要准备的两个 Key

抓帖和 AI 全部走云端接口，网站本身不提供免费额度，每个人填自己的 key。key 只保存在你自己设备的浏览器里，提交分析时随请求发给服务器使用，服务器不保存、不写日志。

### ① 抓帖 key：twitterapi.io

用来读取博主的帖子。

1. 打开 [twitterapi.io](https://twitterapi.io)，注册并登录（可以用 Google 账号）。
2. 登录后进入后台（Dashboard），复制页面上的 **API Key**。
3. 回到网站，展开「我的 Key」，粘贴到第 ① 栏。

费用：

- 新注册送约 **1 美元的额度，也就是 10 万积分**（10 万积分 = 1 美元），不用绑卡。够分析很多个博主，一般用不完。
- 用完以后按量充值。按它公布的价格，大约每 1000 条帖子 0.15 美元（约 1.5 万积分）。
- 它是第三方服务，不是 X 官方的。实际扣多少积分以它后台显示的为准。
- 免费账号有请求频率限制，抓帖会慢一些。

### ② AI 的 key

用来读懂每条帖子在说什么。任选一家你有账号的：

| 服务商 | 去哪拿 Key | 备注 |
|---|---|---|
| Claude（Anthropic） | [console.anthropic.com](https://console.anthropic.com/settings/keys) | 能看图 |
| GPT（OpenAI） | [platform.openai.com](https://platform.openai.com/api-keys) | 能看图 |
| Gemini（Google） | [aistudio.google.com](https://aistudio.google.com/apikey) | 能看图 |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | 便宜；默认模型 `deepseek-flash` 能看图 |
| 通义千问（阿里云百炼） | [bailian.console.aliyun.com](https://bailian.console.aliyun.com/?tab=model#/api-key) | 看图需换成 qwen-vl 系列模型 |
| 豆包（火山方舟） | [console.volcengine.com/ark](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey) | 模型一栏填方舟后台的模型名或接入点 ID（ep- 开头） |
| 其他 | 任何 OpenAI 兼容接口 | 需要自己填接口地址 |

步骤都一样：打开后台 → 创建 API Key → 复制 → 回到网站「我的 Key」里选对服务商并粘贴。

注意：

- 大多数服务商要先充一点余额，key 才能用。
- ChatGPT、Claude、豆包这些 App 的会员**不等于** API 额度，API 要在各自的开发者后台单独开通。
- 页面上预填的模型名只是示例，各家经常更新，以服务商后台显示的为准。
- 花费取决于帖子数量和模型。500 条帖子用便宜的模型通常只要几分到几毛钱人民币，用最强的模型可能要几块到十几块。

## 自己部署一份

这是一个需要常驻后台的 Node 程序（要抓帖、拉行情、调 AI，一次分析持续几分钟到十几分钟），**不能**用 GitHub Pages 这类纯静态托管。需要一个能运行 Docker 容器或 Node 服务的平台，例如 Render、Railway、Zeabur、Fly.io，或者自己的云服务器。

最省事的方式是 Render 一键部署（仓库里已带 `render.yaml`）：

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/logitlong/kol-check)

用 GitHub 账号登录 Render，点上面的按钮，确认后等几分钟，就会得到一个 `https://….onrender.com` 的网址。免费档闲置 15 分钟会休眠，下次打开要等一分钟左右。

其他平台的通用步骤：

1. Fork 或复制这个仓库到你的 GitHub。
2. 在托管平台上新建服务，选择「从 GitHub 仓库部署」，选中仓库。平台会自动识别 `Dockerfile`。
3. 确认环境变量 `HOSTED=1`（Dockerfile 里已经设置；如果平台不用 Docker 而是直接跑 Node，需要手动加上，启动命令为 `npm start`）。
4. 部署完成后平台会给一个 `https://…` 的网址，发给别人即可。

注意：

- **必须用 HTTPS**。使用者的 key 是随请求发送的，用托管平台默认提供的 `https://` 网址即可，不要用 `http://` 对外提供服务。
- **服务器上不需要配置任何 key**。`HOSTED=1` 时服务器只使用访客在页面上填的 key。
- **磁盘可能不持久**。很多平台重新部署后会清空磁盘，「已经分析过的博主」列表会随之清空。要长期保留，给 `data/` 目录挂一个持久卷。
- **并发**：默认同时最多跑 3 个分析，每个访客同一时间只能有 1 个任务，可用环境变量 `MAX_RUNNING` 调整。
- **行情接口**：行情取自 Yahoo Finance，服务器需要能访问它。

本地调试：需要 Node.js 20.12 以上，`npm install && npm start`，然后打开 <http://localhost:4517>，同样在页面上填 key。

## 评分口径

- **进场价**：发帖之后第一个能成交的价格。没开盘时发帖用下一次开盘价；盘中发帖用发帖后的盘中价（两年以前没有盘中数据，用当天收盘价）。不把发帖前已经发生的涨跌算给博主。
- **期限**：每条观点按帖子自己的意思定（今晚 = 1 天，这周 = 5 天，长期 = 几个月）。没明说的由 AI 按措辞推断，页面上标注「推断」。期限内博主自己喊了清仓、止盈或反向，就在那一刻结束。
- **基准**：美股对标普 500，日股对日经 225，韩股对 KOSPI，山寨币对 BTC；BTC 和指数本身对「同期随便哪天买入」的平均收益。
- **分数**：50 分 = 抛硬币。以「跑赢大盘的比例」为主，加上平均超额收益（±15 分封顶），扣危险信号（最多 20 分）。样本越少越向 50 收缩，到期样本不足 5 条不给分。

## 已知局限

- 删掉的帖子读不到，博主事后删除错误预测会让分数虚高。
- 没有考虑仓位和止损。
- 不同 AI 模型对同一条帖子的判断可能不同，换模型分数会有出入。
- twitterapi.io 是非官方服务，数据可能有缺漏，也可能调整价格或停止服务。
- 过去准不代表未来准。

## 目录

```
server.js              HTTP 服务、任务队列
public/index.html      页面
src/analyze.js         主流程
src/sources/           帖子来源（twitterapi.io、X 官方 API）
src/extract/           观点提取（各家 AI 的云端接口）
src/prices.js          行情（Yahoo Finance）
src/score.js           对账与评分
src/symbols.js         标的名称 → 行情代码
```
