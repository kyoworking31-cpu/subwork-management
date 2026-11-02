// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-gray; icon-glyph: tachometer-alt;

/*
 * AI利用枠ウィジェット (Scriptable 用)
 *
 * Claude と ChatGPT(Codex) の
 *   - 5時間枠
 *   - 週間枠 (全体 + モデル別)
 *   - クレジット (Claude: 追加利用 / ChatGPT: クレジット残高)
 * を iPhone のホーム画面ウィジェットに表示します。
 *
 * 使い方は iphone-widget/README.md を参照してください。
 *
 * ※ どちらも公式に公開された API ではなく、claude.ai / chatgpt.com の
 *   Web 画面が内部で使っているエンドポイントを利用しています。
 *   仕様変更で動かなくなる可能性があります。
 */

// ===== 設定 =====
const CONFIG = {
  // ウィジェットの再読み込み間隔 (分)。iOS 側の都合で前後します。
  refreshMinutes: 15,
  // Claude の extra_usage の金額がセント単位で返る場合 true (100 で割って表示)
  claudeCreditsInCents: true,
  claudeCurrency: "$",
  // true: 「残り◯%」を表示 (ChatGPT の画面と同じ) / false: 「使った◯%」を表示
  showRemaining: true,
  // ブラウザに見せかける User-Agent (Cloudflare に弾かれにくくするため)
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  colors: {
    claude: new Color("#D97757"),
    chatgpt: new Color("#10A37F"),
    warn: new Color("#E5A50A"),
    danger: new Color("#E5484D"),
    track: Color.dynamic(new Color("#E5E5EA"), new Color("#3A3A3C")),
    text: Color.dynamic(new Color("#1C1C1E"), new Color("#F2F2F7")),
    sub: Color.dynamic(new Color("#6E6E73"), new Color("#98989D")),
    bg: Color.dynamic(new Color("#FFFFFF"), new Color("#1C1C1E")),
  },
};

const KEY = {
  claudeCookie: "aiusage.claude.cookie",
  claudeOrg: "aiusage.claude.org",
  chatgptCookie: "aiusage.chatgpt.cookie",
  chatgptToken: "aiusage.chatgpt.token",
};

// ===== 共通ユーティリティ =====
const kc = {
  get: (k) => (Keychain.contains(k) ? Keychain.get(k) : null),
  set: (k, v) => Keychain.set(k, v),
  del: (k) => {
    if (Keychain.contains(k)) Keychain.remove(k);
  },
};

const fm = FileManager.local();
const cacheDir = fm.joinPath(fm.documentsDirectory(), "ai-usage-widget");
if (!fm.fileExists(cacheDir)) fm.createDirectory(cacheDir, true);

function readCache(name) {
  const p = fm.joinPath(cacheDir, name + ".json");
  if (!fm.fileExists(p)) return null;
  try {
    return JSON.parse(fm.readString(p));
  } catch (e) {
    return null;
  }
}
function writeCache(name, data) {
  fm.writeString(fm.joinPath(cacheDir, name + ".json"), JSON.stringify(data));
}

// "sessionKey=xxx; other=yyy" でも "xxx" だけでも受け付ける
function toCookieHeader(input, defaultName) {
  const s = (input || "").trim();
  if (!s) return null;
  if (s.includes("=")) return s.replace(/^cookie:\s*/i, "");
  return `${defaultName}=${s}`;
}

async function fetchJSON(url, headers) {
  const req = new Request(url);
  req.timeoutInterval = 20;
  req.headers = Object.assign(
    { "User-Agent": CONFIG.userAgent, Accept: "application/json" },
    headers || {}
  );
  let body;
  try {
    body = await req.loadString();
  } catch (e) {
    throw new Error("通信エラー: " + e.message);
  }
  const status = req.response ? req.response.statusCode : 0;
  if (status === 401 || status === 403) {
    if (/cloudflare|cf-chl|Just a moment/i.test(body || "")) {
      throw new Error("Cloudflareにブロックされました");
    }
    throw new Error(`認証エラー(${status}) Cookieを再設定してください`);
  }
  if (status >= 400) throw new Error(`HTTP ${status}`);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error("JSONではない応答が返りました");
  }
}

// 0〜100 に丸める
function clampPct(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/*
 * 共通データ形式
 * {
 *   provider: "claude" | "chatgpt",
 *   plan: string|null,
 *   rows: [{ label, pct, resetsAt (ms) | null, group: "5h"|"week"|"model" }],
 *   credits: string|null,
 *   fetchedAt: ms,
 * }
 */

// ===== Claude =====
const CLAUDE_LABELS = {
  five_hour: ["5時間", "5h"],
  seven_day: ["週間 全モデル", "week"],
  seven_day_opus: ["週間 Opus", "model"],
  seven_day_sonnet: ["週間 Sonnet", "model"],
  seven_day_haiku: ["週間 Haiku", "model"],
  seven_day_oauth_apps: ["週間 外部アプリ", "model"],
  seven_day_cowork: ["週間 Cowork", "model"],
  claude_design: ["Design", "model"],
};

function prettifyKey(k) {
  return k
    .replace(/^seven_day_/, "週間 ")
    .replace(/^five_hour_/, "5時間 ")
    .replace(/_/g, " ")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function parseClaudeUsage(json) {
  const rows = [];
  let credits = null;
  for (const [k, v] of Object.entries(json || {})) {
    if (!v || typeof v !== "object") continue;
    if (k === "extra_usage") {
      if (v.is_enabled) {
        const div = CONFIG.claudeCreditsInCents ? 100 : 1;
        const cur = CONFIG.claudeCurrency;
        const used = v.used_credits != null ? Number(v.used_credits) / div : null;
        const limit = v.monthly_limit != null ? Number(v.monthly_limit) / div : null;
        if (used != null && limit != null) {
          credits = `${cur}${used.toFixed(2)} / ${cur}${limit.toFixed(2)}`;
        } else if (used != null) {
          credits = `${cur}${used.toFixed(2)} 使用`;
        } else {
          credits = "有効";
        }
      } else {
        credits = "オフ";
      }
      continue;
    }
    if (!("utilization" in v)) continue;
    const pct = clampPct(v.utilization);
    if (pct == null) continue;
    // 公式の使用状況画面に出ない謎の枠 (例: iguana_necktie) は表示しない。
    // 「seven_day_◯◯」「five_hour_◯◯」形式の新しいモデル別枠だけは表示する。
    if (!CLAUDE_LABELS[k] && !/^(seven_day|five_hour)_/.test(k)) continue;
    const [label, group] = CLAUDE_LABELS[k] || [prettifyKey(k), "model"];
    rows.push({
      label,
      pct,
      resetsAt: v.resets_at ? new Date(v.resets_at).getTime() : null,
      group,
    });
  }
  return { rows, credits };
}

// 組織情報からプラン名を推定 (例: "MAX 5x", "PRO")
function claudePlanName(o) {
  const caps = Array.isArray(o.capabilities) ? o.capabilities : [];
  const tier = String(o.rate_limit_tier || "");
  const mult = (tier.match(/(\d+)x/) || [])[1];
  if (caps.includes("claude_max") || /max/i.test(tier)) return mult ? `MAX ${mult}x` : "MAX";
  if (caps.includes("claude_pro") || /pro/i.test(tier)) return "PRO";
  if (caps.includes("raven") || /team|raven/i.test(tier)) return "TEAM";
  if (/enterprise/i.test(tier)) return "ENTERPRISE";
  if (caps.includes("chat")) return "FREE";
  return null;
}

async function fetchClaude() {
  const cookie = toCookieHeader(kc.get(KEY.claudeCookie), "sessionKey");
  if (!cookie) throw new Error("未設定 (アプリ内で実行して設定)");
  const headers = {
    Cookie: cookie,
    Referer: "https://claude.ai/settings/usage",
    Origin: "https://claude.ai",
  };

  // 組織 ID とプラン名は Keychain に覚えておき、1日1回だけ取り直す
  let saved = null;
  try {
    saved = JSON.parse(kc.get(KEY.claudeOrg) || "null");
  } catch (e) {
    saved = null; // 旧バージョンの形式 (ID だけ) は取り直す
  }
  if (!saved || !saved.uuid || Date.now() - (saved.at || 0) > 24 * 3600 * 1000) {
    const orgs = await fetchJSON("https://claude.ai/api/organizations", headers);
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error("組織情報を取得できません");
    }
    // チャット機能を持つ組織 (個人の Pro/Max プラン) を優先
    const chat = orgs.find(
      (o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat")
    );
    const o = chat || orgs[0];
    saved = { uuid: o.uuid, plan: claudePlanName(o), at: Date.now() };
    kc.set(KEY.claudeOrg, JSON.stringify(saved));
  }
  const org = saved.uuid;

  let json;
  try {
    json = await fetchJSON(`https://claude.ai/api/organizations/${org}/usage`, headers);
  } catch (e) {
    // 組織が変わった可能性があるので次回は取り直す
    kc.del(KEY.claudeOrg);
    throw e;
  }
  const { rows, credits } = parseClaudeUsage(json);
  if (rows.length === 0) throw new Error("利用枠データが空でした");
  return { provider: "claude", plan: saved.plan, rows, credits, fetchedAt: Date.now() };
}

// ===== ChatGPT (Codex 利用枠) =====
function windowLabel(win, prefix) {
  const sec = Number(win.limit_window_seconds);
  let span;
  if (sec === 18000) span = "5時間";
  else if (sec === 604800) span = "週間";
  else if (sec >= 86400) span = `${Math.round(sec / 86400)}日`;
  else if (sec > 0) span = `${Math.round(sec / 3600)}時間`;
  else span = "枠";
  return prefix ? `${span} ${prefix}` : span;
}

function windowResetMs(win) {
  if (win.reset_at) {
    const n = Number(win.reset_at);
    // 秒(UNIX) / ミリ秒 / ISO 文字列 のいずれにも対応
    if (isFinite(n)) return n < 1e12 ? n * 1000 : n;
    return new Date(win.reset_at).getTime();
  }
  if (win.reset_after_seconds != null) {
    return Date.now() + Number(win.reset_after_seconds) * 1000;
  }
  return null;
}

function pushWindows(rows, rl, prefix) {
  if (!rl) return;
  for (const name of ["primary_window", "secondary_window"]) {
    const w = rl[name];
    if (!w) continue;
    const pct = clampPct(w.used_percent);
    if (pct == null) continue;
    const sec = Number(w.limit_window_seconds);
    rows.push({
      label: windowLabel(w, prefix),
      pct,
      resetsAt: windowResetMs(w),
      group: prefix ? "model" : sec <= 18000 ? "5h" : "week",
    });
  }
}

function parseChatGPTUsage(json) {
  const rows = [];
  // 全体枠 (5時間 / 週間)
  pushWindows(rows, json.rate_limit, null);
  rows.forEach((r) => {
    if (r.group === "week") r.label = "週間 全モデル";
  });

  // モデル別などの追加枠 (例: GPT-5-Codex-Spark)
  const extra = Array.isArray(json.additional_rate_limits)
    ? json.additional_rate_limits
    : [];
  for (const item of extra) {
    const name = item.limit_name || item.metered_feature || "追加枠";
    pushWindows(rows, item.rate_limit, name);
  }

  // コードレビュー枠
  if (json.code_review_rate_limit) {
    pushWindows(rows, json.code_review_rate_limit, "レビュー");
  }

  let credits = null;
  const c = json.credits;
  if (c) {
    if (c.unlimited) credits = "無制限";
    else if (c.balance != null) {
      const b = Number(c.balance);
      credits = isFinite(b) ? `残 ${b.toLocaleString()}` : `残 ${c.balance}`;
    } else if (c.has_credits === false) credits = "なし";
  }
  return { rows, credits, plan: json.plan_type || null };
}

// 保存された値から、試す Cookie ヘッダーの候補を作る
function chatgptCookieCandidates(raw) {
  const name = "__Secure-next-auth.session-token";
  const clean = (v) => (v || "").replace(/\s+/g, "");
  const str = (raw || "").trim().replace(/^cookie:\s*/i, "");
  if (!str) return { list: [], info: "未設定" };

  // ".0=" と ".1=" に分かれている場合
  const m0 = str.match(/session-token\.0=([^;]+)/);
  const m1 = str.match(/session-token\.1=([^;]+)/);
  if (m0 && m1) {
    let v0 = clean(m0[1]);
    let v1 = clean(m1[1]);
    // 順番を逆に貼った場合は入れ替える (.0 は必ず eyJ で始まる)
    if (!v0.startsWith("eyJ") && v1.startsWith("eyJ")) [v0, v1] = [v1, v0];
    return {
      list: [`${name}.0=${v0}; ${name}.1=${v1}`, `${name}=${v0}${v1}`],
      info: `分割(.0 ${v0.length}文字 ${v0.startsWith("eyJ") ? "OK" : "先頭が不正"} / .1 ${v1.length}文字)`,
    };
  }
  if (str.includes("=")) return { list: [str], info: `Cookie全体 ${str.length}文字` };
  const v = clean(str);
  return {
    list: [`${name}=${v}`],
    info: `1つ(${v.length}文字 ${v.startsWith("eyJ") ? "OK" : "先頭が不正"})`,
  };
}

async function chatgptAccessToken() {
  const manual = kc.get(KEY.chatgptToken);
  const { list, info } = chatgptCookieCandidates(kc.get(KEY.chatgptCookie));
  let lastKeys = "";
  for (const cookie of list) {
    const s = await fetchJSON("https://chatgpt.com/api/auth/session", {
      Cookie: cookie,
      Referer: "https://chatgpt.com/",
    });
    if (s && s.accessToken) {
      return { token: s.accessToken, accountId: s.account ? s.account.id : null };
    }
    lastKeys = Object.keys(s || {}).join(",") || "空";
  }
  if (manual) return { token: manual.replace(/^Bearer\s+/i, ""), accountId: null };
  if (list.length === 0) throw new Error("未設定 (アプリ内で実行して設定)");
  throw new Error(`Cookie切れ/不一致 [${info} / 応答:${lastKeys}]`);
}

async function fetchChatGPT() {
  const { token, accountId } = await chatgptAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Referer: "https://chatgpt.com/codex/settings/usage",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const json = await fetchJSON("https://chatgpt.com/backend-api/wham/usage", headers);
  const { rows, credits, plan } = parseChatGPTUsage(json);
  if (rows.length === 0 && !credits) throw new Error("利用枠データが空でした");
  return { provider: "chatgpt", plan, rows, credits, fetchedAt: Date.now() };
}

// ===== デモデータ (ウィジェットのパラメータに demo と入れると表示) =====
function demoData() {
  const h = 3600 * 1000;
  const now = Date.now();
  return {
    claude: {
      provider: "claude",
      plan: "MAX 5x",
      rows: [
        { label: "5時間", pct: 42, resetsAt: now + 2.3 * h, group: "5h" },
        { label: "週間 全モデル", pct: 67, resetsAt: now + 61 * h, group: "week" },
        { label: "週間 Opus", pct: 91, resetsAt: now + 61 * h, group: "model" },
        { label: "週間 Sonnet", pct: 23, resetsAt: now + 61 * h, group: "model" },
      ],
      credits: "$3.20 / $20.00",
      fetchedAt: now,
    },
    chatgpt: {
      provider: "chatgpt",
      plan: "plus",
      rows: [
        { label: "5時間", pct: 12, resetsAt: now + 4.1 * h, group: "5h" },
        { label: "週間 全モデル", pct: 38, resetsAt: now + 100 * h, group: "week" },
        { label: "5時間 Codex-Spark", pct: 5, resetsAt: now + 4.1 * h, group: "model" },
        { label: "週間 Codex-Spark", pct: 2, resetsAt: now + 100 * h, group: "model" },
      ],
      credits: "残 1,250",
      fetchedAt: now,
    },
  };
}

// ===== 取得 (失敗時はキャッシュ) =====
async function load(name, fn) {
  try {
    const data = await fn();
    writeCache(name, data);
    return { provider: name, data, error: null, stale: false };
  } catch (e) {
    const cached = readCache(name);
    return { provider: name, data: cached, error: e.message, stale: !!cached };
  }
}

// ===== ロゴ (初回だけダウンロードして端末に保存) =====
const LOGO_URLS = {
  claude: [
    "https://claude.ai/apple-touch-icon.png",
    "https://www.google.com/s2/favicons?domain=claude.ai&sz=128",
  ],
  chatgpt: [
    "https://chatgpt.com/apple-touch-icon.png",
    "https://www.google.com/s2/favicons?domain=chatgpt.com&sz=128",
  ],
};
const LOGOS = {};

async function loadLogo(name) {
  const p = fm.joinPath(cacheDir, `logo-${name}.png`);
  if (fm.fileExists(p)) {
    const img = fm.readImage(p);
    if (img) return img;
  }
  for (const url of LOGO_URLS[name]) {
    try {
      const req = new Request(url);
      req.timeoutInterval = 10;
      req.headers = { "User-Agent": CONFIG.userAgent };
      const img = await req.loadImage();
      if (img && img.size.width >= 16) {
        fm.writeImage(p, img);
        return img;
      }
    } catch (e) {
      // 次の候補を試す
    }
  }
  return null; // 取れなければ色付きの ● を表示
}

async function loadLogos() {
  const [c, g] = await Promise.all([loadLogo("claude"), loadLogo("chatgpt")]);
  LOGOS.claude = c;
  LOGOS.chatgpt = g;
}

// ===== 自動アップデート =====
const UPDATE_URL =
  "https://raw.githubusercontent.com/kyoworking31-cpu/subwork-management/claude/iphone-widget-usage-display-r5ox5l/iphone-widget/AIUsageWidget.js";

async function selfUpdate() {
  const code = await new Request(UPDATE_URL).loadString();
  if (!code.includes("AI利用枠ウィジェット")) throw new Error("ダウンロードに失敗しました");
  const path = module.filename;
  let ok = false;
  try {
    FileManager.iCloud().writeString(path, code);
    ok = true;
  } catch (e) {}
  if (!ok) FileManager.local().writeString(path, code);
}

// ===== 描画 =====
function fmtRemain(ms) {
  if (!ms) return "";
  let diff = ms - Date.now();
  if (diff <= 0) return "リセット済";
  const m = Math.floor(diff / 60000);
  const d = Math.floor(m / 1440);
  const hh = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}日${hh}h`;
  if (hh > 0) return `${hh}h${String(mm).padStart(2, "0")}m`;
  return `${mm}m`;
}

function fmtTime(ms) {
  const df = new DateFormatter();
  df.dateFormat = "HH:mm";
  return df.string(new Date(ms));
}

function barColor(pct, base) {
  if (pct >= 90) return CONFIG.colors.danger;
  if (pct >= 75) return CONFIG.colors.warn;
  return base;
}

function drawBar(pct, base, width, height) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const r = height / 2;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, width, height), r, r);
  ctx.addPath(track);
  ctx.setFillColor(CONFIG.colors.track);
  ctx.fillPath();
  const shown = CONFIG.showRemaining ? 100 - pct : pct;
  const w = Math.max(height, (width * shown) / 100);
  if (shown > 0) {
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, 0, w, height), r, r);
    ctx.addPath(fill);
    ctx.setFillColor(barColor(pct, base));
    ctx.fillPath();
  }
  return ctx.getImage();
}

function addText(stack, str, size, color, weight) {
  const t = stack.addText(str);
  t.font =
    weight === "bold"
      ? Font.boldSystemFont(size)
      : weight === "semibold"
      ? Font.semiboldSystemFont(size)
      : Font.systemFont(size);
  t.textColor = color || CONFIG.colors.text;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

function pickRows(rows, max) {
  // 5時間 → 週間 → モデル別 の順。上限を超えたら使用率が高いモデル別を優先
  const order = { "5h": 0, week: 1, model: 2 };
  const base = rows.filter((r) => r.group !== "model");
  const models = rows
    .filter((r) => r.group === "model")
    .sort((a, b) => b.pct - a.pct);
  const picked = base.concat(models).slice(0, max);
  return picked.sort((a, b) => order[a.group] - order[b.group]);
}

function renderProvider(col, title, color, result, opts) {
  const head = col.addStack();
  head.centerAlignContent();
  const logo = LOGOS[result.provider];
  if (logo) {
    const sz = opts.small ? 13 : 15;
    const img = head.addImage(logo);
    img.imageSize = new Size(sz, sz);
    img.cornerRadius = sz * 0.25;
    head.addSpacer(5);
  } else {
    const dot = head.addText("●");
    dot.font = Font.systemFont(opts.small ? 8 : 9);
    dot.textColor = color;
    head.addSpacer(3);
  }
  addText(head, title, opts.small ? 11 : 12, CONFIG.colors.text, "bold");
  const plan = result.data && result.data.plan;
  if (plan && !opts.small) {
    head.addSpacer(4);
    addText(head, plan === plan.toLowerCase() ? plan.toUpperCase() : plan, 9, CONFIG.colors.sub, "semibold");
  }
  head.addSpacer();
  if (result.stale && result.data) {
    addText(head, "⚠︎" + fmtTime(result.data.fetchedAt), 9, CONFIG.colors.warn);
  }

  if (!result.data) {
    col.addSpacer(4);
    const t = addText(col, result.error || "取得失敗", 10, CONFIG.colors.danger);
    t.lineLimit = 3;
    return;
  }

  const rows = pickRows(result.data.rows, opts.maxRows);
  for (const r of rows) {
    col.addSpacer(opts.rowGap);
    const line = col.addStack();
    line.centerAlignContent();
    addText(line, r.label, opts.labelSize, CONFIG.colors.sub);
    line.addSpacer();
    if (opts.showReset && r.resetsAt) {
      addText(line, fmtRemain(r.resetsAt), opts.labelSize - 1, CONFIG.colors.sub);
      line.addSpacer(4);
    }
    const valText = CONFIG.showRemaining
      ? `残り${Math.round(100 - r.pct)}%`
      : `${Math.round(r.pct)}%`;
    addText(line, valText, opts.labelSize, barColor(r.pct, CONFIG.colors.text), "semibold");
    col.addSpacer(2);
    const img = col.addImage(drawBar(r.pct, color, opts.barWidth, opts.barHeight));
    img.imageSize = new Size(opts.barWidth, opts.barHeight);
  }

  if (opts.showCredits && result.data.credits) {
    col.addSpacer(opts.rowGap + 1);
    const c = col.addStack();
    addText(c, "クレジット", opts.labelSize, CONFIG.colors.sub);
    c.addSpacer();
    addText(c, result.data.credits, opts.labelSize, CONFIG.colors.text, "semibold");
  }
}

function layoutOptions(family) {
  switch (family) {
    case "small":
      return { small: true, maxRows: 2, labelSize: 9, rowGap: 2, barWidth: 130, barHeight: 4, showReset: false, showCredits: false };
    case "large":
      return { small: false, maxRows: 8, labelSize: 11, rowGap: 5, barWidth: 300, barHeight: 6, showReset: true, showCredits: true };
    case "extraLarge":
      return { small: false, maxRows: 8, labelSize: 12, rowGap: 6, barWidth: 300, barHeight: 7, showReset: true, showCredits: true };
    default: // medium
      return { small: false, maxRows: 4, labelSize: 9, rowGap: 3, barWidth: 140, barHeight: 4, showReset: true, showCredits: true };
  }
}

// small / large は縦並び、medium は左右2列
function createWidget(claude, chatgpt, family, isDemo) {
  const w = new ListWidget();
  w.backgroundColor = CONFIG.colors.bg;
  w.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60 * 1000);
  const opts = layoutOptions(family);
  const vertical = family === "large" || family === "extraLarge" || family === "small";

  if (vertical) {
    w.setPadding(family === "small" ? 10 : 14, 12, family === "small" ? 10 : 12, 12);
    const a = w.addStack();
    a.layoutVertically();
    renderProvider(a, "Claude", CONFIG.colors.claude, claude, opts);
    w.addSpacer(family === "small" ? 6 : 12);
    const b = w.addStack();
    b.layoutVertically();
    renderProvider(b, "ChatGPT", CONFIG.colors.chatgpt, chatgpt, opts);
  } else {
    w.setPadding(12, 12, 10, 12);
    const row = w.addStack();
    row.layoutHorizontally();
    row.topAlignContent();
    const a = row.addStack();
    a.layoutVertically();
    a.size = new Size(opts.barWidth, 0);
    renderProvider(a, "Claude", CONFIG.colors.claude, claude, opts);
    row.addSpacer();
    const b = row.addStack();
    b.layoutVertically();
    b.size = new Size(opts.barWidth, 0);
    renderProvider(b, "ChatGPT", CONFIG.colors.chatgpt, chatgpt, opts);
  }

  w.addSpacer();
  const foot = w.addStack();
  foot.addSpacer();
  if (isDemo) {
    addText(foot, "見本データ表示中 (Parameter の demo を消すと実データ)", 8, CONFIG.colors.warn, "semibold");
  } else {
    addText(foot, "更新 " + fmtTime(Date.now()), 8, CONFIG.colors.sub);
  }
  return w;
}

// ===== 診断 (データの「形」だけを書き出す。秘密になりうる文字列は伏せる) =====
function describe(v, indent, depth) {
  const pad = "  ".repeat(indent);
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[] (0件)";
    if (depth >= 5) return `[${v.length}件]`;
    if (v.every((x) => x === null || typeof x !== "object")) {
      return `[${v.length}件] ` + v.slice(0, 10).map((x) => describe(x, indent, depth + 1)).join(", ");
    }
    return `[${v.length}件] 先頭:\n${pad}  ` + describe(v[0], indent + 1, depth + 1);
  }
  if (typeof v === "object") {
    if (depth >= 5) return "{…}";
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    return (
      "{\n" +
      keys.map((k) => `${pad}  ${k}: ${describe(v[k], indent + 1, depth + 1)}`).join("\n") +
      `\n${pad}}`
    );
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const str = String(v);
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-][\d:]+)?$/.test(str)) return `"${str}"`; // 日時
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(str)) return "<ID>";
  const digits = (str.match(/\d/g) || []).length;
  if (/^[a-z][a-z0-9_.\-]{0,31}$/i.test(str) && digits <= 3 && !/^eyJ/.test(str)) {
    return `"${str}"`; // 短い英単語 (プラン名・種類など)
  }
  return `<文字列 ${str.length}文字>`;
}

async function diagnose() {
  const out = [`AI利用枠 診断 ${new Date().toISOString()}`];
  const add = async (title, fn) => {
    try {
      out.push(`\n### ${title}\n` + describe(await fn(), 0, 0));
    } catch (e) {
      out.push(`\n### ${title}\n✗ ${e.message}`);
    }
  };

  // Claude
  const cookie = toCookieHeader(kc.get(KEY.claudeCookie), "sessionKey");
  if (cookie) {
    const h = { Cookie: cookie, Referer: "https://claude.ai/settings/usage", Origin: "https://claude.ai" };
    let orgId = null;
    await add("Claude organizations", async () => {
      const orgs = await fetchJSON("https://claude.ai/api/organizations", h);
      const chat = orgs.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat"));
      orgId = (chat || orgs[0]).uuid;
      return chat || orgs[0];
    });
    if (orgId) {
      await add("Claude usage", () => fetchJSON(`https://claude.ai/api/organizations/${orgId}/usage`, h));
    }
  } else {
    out.push("\n### Claude\n未設定");
  }

  // ChatGPT
  try {
    const { token, accountId } = await chatgptAccessToken();
    const h = { Authorization: `Bearer ${token}`, Referer: "https://chatgpt.com/codex/settings/usage" };
    if (accountId) h["ChatGPT-Account-Id"] = accountId;
    await add("ChatGPT wham/usage", () => fetchJSON("https://chatgpt.com/backend-api/wham/usage", h));
    await add("ChatGPT wham/rate-limit-reset-credits", () =>
      fetchJSON("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", h)
    );
  } catch (e) {
    out.push(`\n### ChatGPT\n✗ ${e.message}`);
  }
  return out.join("\n");
}

// ===== 設定メニュー (アプリ内で実行したとき) =====
async function prompt(title, message, placeholder, current) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addSecureTextField(placeholder, current || "");
  a.addAction("保存");
  a.addCancelAction("キャンセル");
  const i = await a.presentAlert();
  if (i === -1) return null;
  return a.textFieldValue(0).trim();
}

async function notify(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction("OK");
  await a.presentAlert();
}

async function setupMenu() {
  while (true) {
    const a = new Alert();
    a.title = "AI利用枠ウィジェット";
    a.message =
      `Claude: ${kc.get(KEY.claudeCookie) ? "設定済み" : "未設定"}\n` +
      `ChatGPT: ${kc.get(KEY.chatgptCookie) || kc.get(KEY.chatgptToken) ? "設定済み" : "未設定"}`;
    a.addAction("プレビュー (中)");
    a.addAction("プレビュー (大)");
    a.addAction("Claude の Cookie を設定");
    a.addAction("ChatGPT の Cookie を設定");
    a.addAction("ChatGPT のアクセストークンを設定 (任意)");
    a.addAction("接続テスト");
    a.addAction("最新版に更新");
    a.addAction("データ構造を診断 (開発用)");
    a.addDestructiveAction("保存した認証情報をすべて削除");
    a.addCancelAction("閉じる");
    const i = await a.presentSheet();
    if (i === -1) return;

    if (i === 0 || i === 1) {
      const family = i === 0 ? "medium" : "large";
      const [c, g] = await Promise.all([load("claude", fetchClaude), load("chatgpt", fetchChatGPT)]);
      const w = createWidget(c, g, family);
      if (family === "medium") await w.presentMedium();
      else await w.presentLarge();
    } else if (i === 2) {
      const v = await prompt(
        "Claude の Cookie",
        "PCのブラウザで claude.ai にログイン → 開発者ツール → Application(ストレージ) → Cookies → claude.ai の「sessionKey」の値 (sk-ant-sid01-…) を貼り付けてください。\n「Cookie: …」のヘッダー全体でも可。",
        "sk-ant-sid01-...",
        ""
      );
      if (v) {
        kc.set(KEY.claudeCookie, v);
        kc.del(KEY.claudeOrg);
      }
    } else if (i === 3) {
      const v = await prompt(
        "ChatGPT の Cookie (1つ目)",
        "PCのブラウザの開発者ツール → Cookies → https://chatgpt.com の「__Secure-next-auth.session-token」の値を貼り付けてください。\n.0 / .1 に分かれている場合は、ここに「.0」の値を貼り付けてください。",
        "eyJhbGciOi...",
        ""
      );
      if (v) {
        const v2 = await prompt(
          "ChatGPT の Cookie (2つ目)",
          "「.0」「.1」に分かれていた場合は、ここに「.1」の値を貼り付けて保存してください。\n分かれていなかった場合は、空のまま「保存」を押してください。",
          "(分かれていなければ空のまま)",
          ""
        );
        const name = "__Secure-next-auth.session-token";
        if (v.includes("=")) {
          kc.set(KEY.chatgptCookie, v); // Cookie ヘッダー全体が貼られた場合
        } else if (v2) {
          kc.set(KEY.chatgptCookie, `${name}.0=${v}; ${name}.1=${v2}`);
        } else {
          kc.set(KEY.chatgptCookie, v);
        }
      }
    } else if (i === 4) {
      const v = await prompt(
        "ChatGPT アクセストークン",
        "Cookie 方式がうまくいかない場合の代替です。https://chatgpt.com/api/auth/session を開いて表示される accessToken の値を貼り付けます (約10日で期限切れ)。空で保存すると削除します。",
        "eyJhbGciOi...",
        ""
      );
      if (v === "") kc.del(KEY.chatgptToken);
      else if (v) kc.set(KEY.chatgptToken, v);
    } else if (i === 5) {
      const [c, g] = await Promise.all([load("claude", fetchClaude), load("chatgpt", fetchChatGPT)]);
      const line = (name, r) =>
        r.error
          ? `${name}: ✗ ${r.error}`
          : `${name}: ✓ ${r.data.rows.length}件の枠${r.data.credits ? " / クレジット " + r.data.credits : ""}`;
      await notify("接続テスト", line("Claude", c) + "\n\n" + line("ChatGPT", g));
    } else if (i === 6) {
      try {
        await selfUpdate();
        await notify("更新しました", "スクリプトを閉じて、もう一度開き直してください。");
        return;
      } catch (e) {
        await notify("更新できませんでした", e.message);
      }
    } else if (i === 7) {
      const text = await diagnose();
      Pasteboard.copyString(text);
      await notify(
        "診断結果をコピーしました",
        "Claude の会話に貼り付けて送ってください。ログイン情報や ID は含まれていません (数値・はい/いいえ・日時・短い英単語だけです)。"
      );
      await QuickLook.present(text, true);
    } else if (i === 8) {
      Object.values(KEY).forEach(kc.del);
      await notify("削除しました", "Keychain から認証情報を削除しました。");
    }
  }
}

// ===== エントリーポイント =====
async function main() {
  const param = (args.widgetParameter || "").trim().toLowerCase();
  await loadLogos();

  if (config.runsInWidget || param === "demo") {
    let claude, chatgpt;
    if (param === "demo") {
      const d = demoData();
      claude = { provider: "claude", data: d.claude, error: null, stale: false };
      chatgpt = { provider: "chatgpt", data: d.chatgpt, error: null, stale: false };
    } else {
      [claude, chatgpt] = await Promise.all([
        load("claude", fetchClaude),
        load("chatgpt", fetchChatGPT),
      ]);
    }
    const family = config.widgetFamily || "medium";
    const w = createWidget(claude, chatgpt, family, param === "demo");
    if (config.runsInWidget) Script.setWidget(w);
    else await w.presentMedium();
  } else {
    await setupMenu();
  }
  Script.complete();
}

await main();
