/**
 * YouTube Content Script — 当前进度 ±30s 字幕上下文
 * 输出字段严格对齐 schemas.SubtitleContext / SubtitleSegment
 *
 * 背景：WEB captionTracks.baseUrl 常带 exp=xpe，无 PoToken(pot) 时 timedtext
 * 返回 HTTP 200 + 空 body。CC 能显示是因为播放器请求自带 pot。
 *
 * 策略优先级：
 * 1) Performance 里已有的带 pot timedtext URL（CC 开过后最稳）
 * 2) 拦截播放器后续 timedtext，并轻推 CC 重载
 * 3) Innertube IOS / TV_SIMPLY 等非 WEB 客户端换轨
 * 4) WEB baseUrl 直拉（少数无 xpe 的视频）
 * 5) textTracks 兜底
 */

export type SubtitleSegment = {
  timestamp: string;
  text: string;
};

export type SubtitleContext = {
  current_timestamp: string;
  segments: SubtitleSegment[];
};

/** 字幕窗口半宽（秒） */
const WINDOW_SECONDS = 30;

const TIMEDTEXT_EVENT = "freshvid:timedtext";
const INTERCEPTOR_FLAG = "__freshvidTimedtextHooked";

/**
 * 将秒数格式化为 "HH:MM:SS"（对齐 schemas 示例 "00:01:23"）。
 */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * 剔除 YouTube 字幕中的格式标签、HTML 实体与多余空白。
 */
export function cleanSubtitleText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/\{\\.*?\}/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 根据当前播放进度，提取前后 30 秒字幕上下文。
 * 字幕不可用时不抛错，返回 segments: []，仅保留 current_timestamp。
 */
export async function getSubtitleContext(
  video: HTMLVideoElement,
): Promise<SubtitleContext> {
  const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const current_timestamp = formatTimestamp(currentTime);
  const windowStart = Math.max(0, currentTime - WINDOW_SECONDS);
  const windowEnd = currentTime + WINDOW_SECONDS;

  try {
    const cues = await loadSubtitleCues();
    const segments = cues
      .filter((c) => c.startSeconds < windowEnd && c.endSeconds > windowStart)
      .map((c) => ({
        timestamp: formatTimestamp(c.startSeconds),
        text: cleanSubtitleText(c.text),
      }))
      .filter((s) => s.text.length > 0);

    return { current_timestamp, segments };
  } catch {
    return { current_timestamp, segments: [] };
  }
}

// ─── internal ───────────────────────────────────────────────────────────────

type RawCue = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

type CaptionTrack = {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
};

type PlayerResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: unknown[];
    };
  };
};

type InnertubeClient = {
  clientName: string;
  clientVersion: string;
  /** TV_SIMPLY 等对登录 cookie 不友好，需 omit */
  credentials?: RequestCredentials;
  userAgent?: string;
  clientId?: string;
};

/**
 * IOS / TV_SIMPLY：字幕轨通常不强制 WEB PoToken。
 * 已登录会话下 TVHTML5 常不返回 captionTracks，故不优先。
 */
const FALLBACK_CLIENTS: InnertubeClient[] = [
  {
    clientName: "IOS",
    clientVersion: "20.10.38",
    credentials: "omit",
    userAgent:
      "com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    clientId: "5",
  },
  {
    clientName: "TVHTML5_SIMPLY",
    clientVersion: "1.0",
    credentials: "omit",
    clientId: "85",
  },
  {
    clientName: "ANDROID_VR",
    clientVersion: "1.60.19",
    credentials: "omit",
    clientId: "28",
  },
];

/** 页面拦截到的 timedtext 原文缓存（带 pot 的完整字幕） */
let cachedTimedtextBody: string | null = null;

async function loadSubtitleCues(): Promise<RawCue[]> {
  ensureTimedtextInterceptor();

  // 1) 拦截缓存
  if (cachedTimedtextBody) {
    const cues = parseTimedtextBody(cachedTimedtextBody);
    if (cues.length > 0) return cues;
  }

  // 2) Performance：复用播放器已发出的带 pot timedtext（CC 开过后最稳）
  const fromPerf = await fetchCuesFromPerformanceEntries();
  if (fromPerf.length > 0) return fromPerf;

  // 3) 轻推 CC，截获播放器带 pot 的请求
  const intercepted = await capturePlayerTimedtext(3000);
  if (intercepted.length > 0) return intercepted;

  // 4) Innertube 非 WEB 客户端换轨（免 pot）
  const videoId = getVideoId();
  if (videoId) {
    for (const client of FALLBACK_CLIENTS) {
      const tracks = await fetchCaptionTracksViaInnertube(videoId, client);
      const cues = await fetchCuesFromTracks(tracks);
      if (cues.length > 0) return cues;
    }
  }

  // 5) WEB baseUrl 直拉（无 xpe 时可用）
  const fromWeb = await fetchCuesFromTracks(
    getCaptionTracks(getPlayerResponse()),
  );
  if (fromWeb.length > 0) return fromWeb;

  // 6) 再扫一次 Performance（重载后可能刚写入）
  const fromPerf2 = await fetchCuesFromPerformanceEntries();
  if (fromPerf2.length > 0) return fromPerf2;

  return loadCuesFromTextTracks();
}

/**
 * 从 Resource Timing 找到播放器已请求的 timedtext（通常含 pot=），再 fetch 一次。
 */
async function fetchCuesFromPerformanceEntries(): Promise<RawCue[]> {
  let entries: PerformanceResourceTiming[] = [];
  try {
    entries = performance
      .getEntriesByType("resource")
      .filter((e): e is PerformanceResourceTiming =>
        typeof e.name === "string" && e.name.includes("/api/timedtext"),
      );
  } catch {
    return [];
  }
  if (entries.length === 0) return [];

  // 优先带 pot 的；同 URL 取最新
  const urls = [
    ...new Set(
      [...entries]
        .sort((a, b) => {
          const ap = a.name.includes("pot=") ? 1 : 0;
          const bp = b.name.includes("pot=") ? 1 : 0;
          if (ap !== bp) return bp - ap;
          return b.startTime - a.startTime;
        })
        .map((e) => e.name),
    ),
  ];

  for (const url of urls) {
    const cues = await fetchAndParseTimedText(url);
    if (cues.length > 0) return cues;
  }
  return [];
}

async function fetchCuesFromTracks(tracks: CaptionTrack[]): Promise<RawCue[]> {
  const track = pickCaptionTrack(tracks);
  if (!track?.baseUrl) return [];

  const urls = [
    track.baseUrl,
    appendQueryParam(track.baseUrl, "fmt", "json3"),
    appendQueryParam(track.baseUrl, "fmt", "srv3"),
  ];

  for (const url of urls) {
    const cues = await fetchAndParseTimedText(url);
    if (cues.length > 0) return cues;
  }
  return [];
}

async function fetchAndParseTimedText(url: string): Promise<RawCue[]> {
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: { Accept: "*/*" },
    });
    if (!res.ok) return [];
    const body = (await res.text()).trim();
    if (!body) return [];
    cachedTimedtextBody = body;
    return parseTimedtextBody(body);
  } catch {
    return [];
  }
}

function parseTimedtextBody(body: string): RawCue[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return parseJson3(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  return parseTimedTextXml(trimmed);
}

// ─── Innertube fallback（绕过 WEB PoToken）──────────────────────────────────

async function fetchCaptionTracksViaInnertube(
  videoId: string,
  client: InnertubeClient,
): Promise<CaptionTrack[]> {
  try {
    const key = getInnertubeApiKey();
    const url = key
      ? `/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`
      : `/youtubei/v1/player?prettyPrint=false`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-YouTube-Client-Name":
        client.clientId ?? clientNameToId(client.clientName),
      "X-YouTube-Client-Version": client.clientVersion,
    };
    if (client.userAgent) headers["User-Agent"] = client.userAgent;

    const visitor = getVisitorData();
    if (visitor) headers["X-Goog-Visitor-Id"] = visitor;

    const res = await fetch(url, {
      method: "POST",
      credentials: client.credentials ?? "omit",
      headers,
      body: JSON.stringify({
        context: {
          client: {
            clientName: client.clientName,
            clientVersion: client.clientVersion,
            hl: "en",
            gl: "US",
            ...(client.userAgent ? { userAgent: client.userAgent } : {}),
          },
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as PlayerResponse;
    return getCaptionTracks(data);
  } catch {
    return [];
  }
}

function getInnertubeApiKey(): string | null {
  const w = window as Window & {
    ytcfg?: { get?: (k: string) => unknown; data_?: Record<string, unknown> };
  };
  const fromCfg = w.ytcfg?.get?.("INNERTUBE_API_KEY");
  if (typeof fromCfg === "string" && fromCfg) return fromCfg;
  const fromData = w.ytcfg?.data_?.INNERTUBE_API_KEY;
  if (typeof fromData === "string" && fromData) return fromData;
  return "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
}

function getVisitorData(): string | null {
  const w = window as Window & {
    ytcfg?: { get?: (k: string) => unknown };
  };
  const v = w.ytcfg?.get?.("VISITOR_DATA");
  return typeof v === "string" && v ? v : null;
}

function clientNameToId(name: string): string {
  switch (name) {
    case "IOS":
      return "5";
    case "TVHTML5":
      return "7";
    case "TVHTML5_SIMPLY":
      return "85";
    case "ANDROID_VR":
      return "28";
    case "WEB_EMBEDDED_PLAYER":
      return "56";
    default:
      return "1";
  }
}

function getVideoId(): string | null {
  try {
    const fromUrl = new URLSearchParams(location.search).get("v");
    if (fromUrl) return fromUrl;
  } catch {
    // ignore
  }
  const player = document.querySelector("#movie_player") as
    | (HTMLElement & { getVideoData?: () => { video_id?: string } })
    | null;
  const id = player?.getVideoData?.()?.video_id;
  return id || null;
}

// ─── 拦截播放器自带 timedtext（含 pot）──────────────────────────────────────

function ensureTimedtextInterceptor(): void {
  const w = window as Window & { [INTERCEPTOR_FLAG]?: boolean };
  if (w[INTERCEPTOR_FLAG]) return;
  w[INTERCEPTOR_FLAG] = true;

  window.addEventListener(TIMEDTEXT_EVENT, ((ev: CustomEvent<string>) => {
    const body = typeof ev.detail === "string" ? ev.detail.trim() : "";
    if (body) cachedTimedtextBody = body;
  }) as EventListener);

  tryInjectHookInPage();
}

function tryInjectHookInPage(): void {
  const code = `(() => {
    if (window.${INTERCEPTOR_FLAG}Hooked) return;
    window.${INTERCEPTOR_FLAG}Hooked = true;
    const emit = (text) => {
      if (!text || !String(text).trim()) return;
      window.dispatchEvent(new CustomEvent('${TIMEDTEXT_EVENT}', { detail: String(text) }));
    };
    const ofetch = window.fetch;
    window.fetch = function (...args) {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req && req.url) || '';
      return ofetch.apply(this, args).then((res) => {
        if (typeof url === 'string' && url.includes('/api/timedtext')) {
          res.clone().text().then(emit).catch(() => {});
        }
        return res;
      });
    };
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__fvUrl = String(url);
      return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        if (this.__fvUrl && this.__fvUrl.includes('/api/timedtext')) {
          emit(this.responseText);
        }
      });
      return send.apply(this, args);
    };
  })();`;

  try {
    // eslint-disable-next-line no-new-func
    Function(code)();
  } catch {
    // ignore
  }

  try {
    const script = document.createElement("script");
    script.textContent = code;
    (document.documentElement || document.head).appendChild(script);
    script.remove();
  } catch {
    // CSP 可能拦截；依赖 Performance / Innertube
  }
}

async function capturePlayerTimedtext(timeoutMs: number): Promise<RawCue[]> {
  ensureTimedtextInterceptor();

  if (cachedTimedtextBody) {
    const cues = parseTimedtextBody(cachedTimedtextBody);
    if (cues.length > 0) return cues;
  }

  const wait = waitForTimedtext(timeoutMs);
  nudgePlayerToReloadCaptions();
  const body = await wait;
  if (!body) return [];
  return parseTimedtextBody(body);
}

function waitForTimedtext(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (cachedTimedtextBody) {
      resolve(cachedTimedtextBody);
      return;
    }
    const timer = window.setTimeout(() => {
      window.removeEventListener(TIMEDTEXT_EVENT, onEvent as EventListener);
      resolve(cachedTimedtextBody);
    }, timeoutMs);

    function onEvent(ev: Event) {
      const detail = (ev as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.trim()) {
        window.clearTimeout(timer);
        window.removeEventListener(TIMEDTEXT_EVENT, onEvent as EventListener);
        resolve(detail);
      }
    }
    window.addEventListener(TIMEDTEXT_EVENT, onEvent as EventListener);
  });
}

function nudgePlayerToReloadCaptions(): void {
  const player = document.querySelector("#movie_player") as
    | (HTMLElement & {
        setOption?: (mod: string, opt: string, value: unknown) => void;
        toggleSubtitles?: () => void;
      })
    | null;
  if (!player) return;

  try {
    const track = pickCaptionTrack(getCaptionTracks(getPlayerResponse()));
    if (player.setOption && track) {
      player.setOption("captions", "track", {});
      window.setTimeout(() => {
        player.setOption?.("captions", "track", {
          languageCode: track.languageCode,
          kind: track.kind || "",
        });
      }, 120);
      return;
    }
  } catch {
    // fall through
  }

  try {
    player.toggleSubtitles?.();
    window.setTimeout(() => player.toggleSubtitles?.(), 150);
  } catch {
    // ignore
  }
}

// ─── playerResponse / tracks ────────────────────────────────────────────────

function getCaptionTracks(response: PlayerResponse | null): CaptionTrack[] {
  const tracks =
    response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks)) return [];
  return tracks.filter(
    (t): t is CaptionTrack =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as CaptionTrack).baseUrl === "string",
  );
}

function pickCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;
  return [...tracks].sort((a, b) => scoreTrack(b) - scoreTrack(a))[0] ?? null;
}

function scoreTrack(t: CaptionTrack): number {
  let score = 0;
  const lang = (t.languageCode ?? "").toLowerCase();
  const kind = (t.kind ?? "").toLowerCase();
  const vss = (t.vssId ?? "").toLowerCase();
  if (lang.startsWith("en")) score += 3;
  if (lang.startsWith("zh")) score += 2;
  if (kind !== "asr") score += 1;
  if (vss.includes(".en") || vss.includes(".zh")) score += 1;
  if (!t.baseUrl.includes("exp=xpe")) score += 5;
  return score;
}

function getPlayerResponse(): PlayerResponse | null {
  const w = window as Window & {
    ytInitialPlayerResponse?: unknown;
    ytplayer?: { config?: { args?: { player_response?: string } } };
  };

  const player = document.querySelector("#movie_player") as
    | (HTMLElement & { getPlayerResponse?: () => unknown })
    | null;
  if (player && typeof player.getPlayerResponse === "function") {
    try {
      const resp = player.getPlayerResponse();
      if (resp && typeof resp === "object") return resp as PlayerResponse;
    } catch {
      // ignore
    }
  }

  if (
    w.ytInitialPlayerResponse &&
    typeof w.ytInitialPlayerResponse === "object"
  ) {
    return w.ytInitialPlayerResponse as PlayerResponse;
  }

  const raw = w.ytplayer?.config?.args?.player_response;
  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      return JSON.parse(raw) as PlayerResponse;
    } catch {
      return null;
    }
  }
  return null;
}

function appendQueryParam(baseUrl: string, key: string, value: string): string {
  if (new RegExp(`[?&]${key}=`).test(baseUrl)) {
    return baseUrl.replace(
      new RegExp(`([?&])${key}=[^&]*`),
      `$1${key}=${encodeURIComponent(value)}`,
    );
  }
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}${key}=${encodeURIComponent(value)}`;
}

// ─── parsers ────────────────────────────────────────────────────────────────

function parseJson3(data: unknown): RawCue[] {
  if (!data || typeof data !== "object") return [];
  const events = (data as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];

  const cues: RawCue[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as {
      tStartMs?: number;
      dDurationMs?: number;
      segs?: Array<{ utf8?: string }>;
    };
    if (typeof e.tStartMs !== "number" || !Array.isArray(e.segs)) continue;

    const text = e.segs
      .map((s) => (typeof s?.utf8 === "string" ? s.utf8 : ""))
      .join("")
      .replace(/\n/g, " ");
    const cleaned = cleanSubtitleText(text);
    if (!cleaned) continue;

    const startSeconds = e.tStartMs / 1000;
    const durationMs =
      typeof e.dDurationMs === "number" && e.dDurationMs > 0
        ? e.dDurationMs
        : 2000;
    cues.push({
      startSeconds,
      endSeconds: startSeconds + durationMs / 1000,
      text: cleaned,
    });
  }
  return cues;
}

function parseTimedTextXml(xml: string): RawCue[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return [];

  const nodes = Array.from(doc.querySelectorAll("text, p"));
  const cues: RawCue[] = [];

  for (const node of nodes) {
    const startAttr = node.getAttribute("start") ?? node.getAttribute("t");
    if (startAttr == null) continue;

    let startSeconds = parseFloat(startAttr);
    if (!Number.isFinite(startSeconds)) continue;

    const usesMs =
      node.hasAttribute("t") ||
      node.hasAttribute("d") ||
      startSeconds > 1e5;

    if (usesMs && !node.hasAttribute("start")) {
      startSeconds = startSeconds / 1000;
    }

    let durationSeconds = 2;
    const dur = node.getAttribute("dur");
    const d = node.getAttribute("d");
    if (dur != null && Number.isFinite(parseFloat(dur))) {
      durationSeconds = parseFloat(dur);
    } else if (d != null && Number.isFinite(parseFloat(d))) {
      durationSeconds = parseFloat(d) / 1000;
    }

    const text = cleanSubtitleText(node.textContent ?? "");
    if (!text) continue;

    cues.push({
      startSeconds,
      endSeconds: startSeconds + durationSeconds,
      text,
    });
  }
  return cues;
}

function loadCuesFromTextTracks(): RawCue[] {
  const video =
    document.querySelector<HTMLVideoElement>("video.html5-main-video") ??
    document.querySelector("video");
  if (!video?.textTracks) return [];

  const cues: RawCue[] = [];
  for (let i = 0; i < video.textTracks.length; i++) {
    const track = video.textTracks[i];
    if (!track) continue;
    const prev = track.mode;
    if (track.mode === "disabled") track.mode = "hidden";

    const list = track.cues;
    if (list) {
      for (let j = 0; j < list.length; j++) {
        const cue = list[j];
        if (!cue) continue;
        const text =
          "text" in cue && typeof (cue as VTTCue).text === "string"
            ? (cue as VTTCue).text
            : "";
        const cleaned = cleanSubtitleText(text);
        if (!cleaned) continue;
        cues.push({
          startSeconds: cue.startTime,
          endSeconds: cue.endTime,
          text: cleaned,
        });
      }
    }
    track.mode = prev;
  }
  return cues;
}
