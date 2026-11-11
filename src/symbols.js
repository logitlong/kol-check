// 把帖子里出现的各种叫法统一成 Yahoo Finance 代码，并给每个市场配一个基准。

const CRYPTO = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT", "LTC", "TON", "SUI", "PEPE", "SHIB"];

// 常见中文/英文名称 → 代码。规则提取器用；LLM 提取器直接输出代码。
export const NAME_MAP = {
  比特币: "BTC-USD", 大饼: "BTC-USD", bitcoin: "BTC-USD",
  以太坊: "ETH-USD", 以太: "ETH-USD", 姨太: "ETH-USD", ethereum: "ETH-USD",
  狗狗币: "DOGE-USD", solana: "SOL-USD",
  英伟达: "NVDA", nvidia: "NVDA", 特斯拉: "TSLA", tesla: "TSLA", 苹果: "AAPL", apple: "AAPL",
  微软: "MSFT", microsoft: "MSFT", 谷歌: "GOOGL", google: "GOOGL", 亚马逊: "AMZN", amazon: "AMZN",
  脸书: "META", 奈飞: "NFLX", 网飞: "NFLX", 超微: "AMD", 台积电: "TSM", 博通: "AVGO",
  英特尔: "INTC", 帕兰提尔: "PLTR", palantir: "PLTR", 微策略: "MSTR", 阿里巴巴: "BABA", 阿里: "BABA",
  拼多多: "PDD", 蔚来: "NIO", 腾讯: "0700.HK",
  纳指: "QQQ", 纳斯达克: "QQQ", nasdaq: "QQQ", 标普: "SPY", "s&p": "SPY", 美股大盘: "SPY", 道指: "DIA",
  三星电子: "005930.KS", 三星: "005930.KS", samsung: "005930.KS", 海力士: "000660.KS", "sk hynix": "000660.KS",
  韩股: "^KS11", kospi: "^KS11",
  // 日股（中文 / 日文 / 英文叫法）
  丰田: "7203.T", トヨタ: "7203.T", toyota: "7203.T",
  索尼: "6758.T", ソニー: "6758.T", sony: "6758.T",
  软银: "9984.T", ソフトバンクグループ: "9984.T", ソフトバンクg: "9984.T", softbank: "9984.T",
  任天堂: "7974.T", nintendo: "7974.T",
  东京电子: "8035.T", 東京エレクトロン: "8035.T", 东电电子: "8035.T", "tokyo electron": "8035.T",
  爱德万: "6857.T", アドバンテスト: "6857.T", advantest: "6857.T",
  基恩士: "6861.T", キーエンス: "6861.T", keyence: "6861.T",
  三菱日联: "8306.T", 三菱ufj: "8306.T", mufg: "8306.T",
  三井住友: "8316.T", 迅销: "9983.T", 优衣库: "9983.T", ファーストリテイリング: "9983.T", ユニクロ: "9983.T",
  三菱商事: "8058.T", 三井物产: "8031.T", 三井物産: "8031.T", 伊藤忠: "8001.T",
  三菱重工: "7011.T", 日立: "6501.T", 本田: "7267.T", ホンダ: "7267.T", honda: "7267.T",
  日产: "7201.T", 日産: "7201.T", nissan: "7201.T",
  瑞萨: "6723.T", ルネサス: "6723.T", renesas: "6723.T",
  lasertec: "6920.T", レーザーテック: "6920.T", 信越化学: "4063.T", 武田药品: "4502.T", 武田薬品: "4502.T",
  瑞可利: "6098.T", リクルート: "6098.T", metaplanet: "3350.T", メタプラネット: "3350.T",
  日经: "^N225", 日経平均: "^N225", 日経: "^N225", nikkei: "^N225", 日股: "^N225", 日本株: "^N225", topix: "1306.T",
  黄金: "GC=F", gold: "GC=F",
};

/** "$nvda" / "BTC" / "005930" / "7203.T" → Yahoo 代码；认不出返回 null。 */
export function normalizeSymbol(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^\$/, "");
  if (!s) return null;
  const lower = s.toLowerCase();
  if (NAME_MAP[lower]) return NAME_MAP[lower];
  if (NAME_MAP[s]) return NAME_MAP[s];
  s = s.toUpperCase();
  if (/^[A-Z0-9]+-USD$/.test(s)) return s;
  if (/^[A-Z]+USDT?$/.test(s) && CRYPTO.includes(s.replace(/USDT?$/, ""))) return s.replace(/USDT?$/, "") + "-USD";
  if (CRYPTO.includes(s)) return s + "-USD";
  if (/^\d{6}$/.test(s)) return s + ".KS"; // 韩股 6 位数字
  if (/^\d{4}$/.test(s)) return s + ".T"; // 日股 4 位数字
  if (/^\^?[A-Z0-9]{1,6}([.=\-][A-Z0-9]{1,4})?$/.test(s)) return s;
  return null;
}

/** 该标的对应的"大盘"，用来算超额收益；返回 null 表示不做基准对比。 */
export function benchmarkFor(symbol) {
  if (symbol.startsWith("^") || symbol.includes("=")) return null;
  if (symbol === "BTC-USD") return null; // BTC 自己就是币圈基准
  if (symbol.endsWith("-USD")) return "BTC-USD";
  if (symbol.endsWith(".KS")) return "^KS11";
  if (symbol.endsWith(".KQ")) return "^KQ11";
  if (symbol.endsWith(".T")) return "^N225";
  if (symbol.endsWith(".HK")) return "^HSI";
  if (["SPY", "QQQ", "DIA", "IWM", "1306.T"].includes(symbol)) return null;
  return "SPY";
}
