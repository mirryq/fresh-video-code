/**
 * Background Service Worker — 请求中继
 * 接收 Content Script 的 ANALYZE_CODE，将 AnalysisPayload 转发至后端分析接口。
 */

/** 对齐 schemas.AnalysisPayload */
type SubtitleSegment = {
  timestamp: string;
  text: string;
};

type SubtitleContext = {
  current_timestamp: string;
  segments: SubtitleSegment[];
};

type AnalysisPayload = {
  image_base64: string;
  subtitles: SubtitleContext;
};

type AnalyzeCodeMessage = {
  type: "ANALYZE_CODE";
  payload: AnalysisPayload;
};

/** 本地分析服务；后续可由 chrome.storage / 环境配置覆盖 */
const ANALYZE_ENDPOINT = "http://127.0.0.1:8000/analyze";

type RelaySuccess = {
  ok: true;
  data: unknown;
};

type RelayFailure = {
  ok: false;
  error: string;
};

type RelayResponse = RelaySuccess | RelayFailure;

function isAnalyzeCodeMessage(msg: unknown): msg is AnalyzeCodeMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== "ANALYZE_CODE") return false;
  const payload = m.payload as Record<string, unknown> | undefined;
  return (
    !!payload &&
    typeof payload.image_base64 === "string" &&
    !!payload.subtitles &&
    typeof payload.subtitles === "object"
  );
}

async function forwardAnalyze(
  payload: AnalysisPayload,
): Promise<RelayResponse> {
  try {
    const res = await fetch(ANALYZE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应原样返回
    }

    if (!res.ok) {
      const detail =
        typeof data === "object" && data && "detail" in data
          ? String((data as { detail: unknown }).detail)
          : text || res.statusText;
      return {
        ok: false,
        error: `分析服务返回 ${res.status}: ${detail}`,
      };
    }

    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `无法连接分析服务 (${ANALYZE_ENDPOINT}): ${message}`,
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isAnalyzeCodeMessage(message)) {
    return false;
  }

  forwardAnalyze(message.payload).then(sendResponse);
  // 异步 sendResponse 必须返回 true
  return true;
});
