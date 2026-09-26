/**
 * Content Script 聚合入口
 * 并发截帧 + 字幕 → AnalysisPayload → 转发 Background
 * 字段对齐 schemas.AnalysisPayload
 */

import {
  captureCurrentFrame,
  CaptureFrameError,
  findActiveVideo,
} from "./captureFrame";
import {
  formatTimestamp,
  getSubtitleContext,
  type SubtitleContext,
} from "./subtitle";

/** 对齐 schemas.AnalysisPayload */
export type AnalysisPayload = {
  image_base64: string;
  subtitles: SubtitleContext;
};

export type AnalyzeCodeMessage = {
  type: "ANALYZE_CODE";
  payload: AnalysisPayload;
};

function defaultSubtitleContext(video: HTMLVideoElement): SubtitleContext {
  const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  return {
    current_timestamp: formatTimestamp(currentTime),
    segments: [],
  };
}

/**
 * 字幕失败或结果无效时回落默认上下文；空 segments 不阻断。
 */
async function safeSubtitleContext(
  video: HTMLVideoElement,
): Promise<SubtitleContext> {
  const fallback = defaultSubtitleContext(video);
  try {
    const ctx = await getSubtitleContext(video);
    if (
      !ctx ||
      typeof ctx.current_timestamp !== "string" ||
      !Array.isArray(ctx.segments)
    ) {
      return fallback;
    }
    return {
      current_timestamp: ctx.current_timestamp || fallback.current_timestamp,
      segments: ctx.segments,
    };
  } catch {
    return fallback;
  }
}

/**
 * 聚合当前活跃视频的截帧与字幕，严格输出 AnalysisPayload。
 */
export async function collectAnalysisPayload(): Promise<AnalysisPayload> {
  const video = findActiveVideo();
  if (!video) {
    throw new CaptureFrameError(
      "未找到可用的 <video> 元素（请确认在 YouTube 播放页，且播放器已加载）。",
      "NO_VIDEO",
    );
  }

  // captureCurrentFrame 为同步；Promise.all 仍可与异步字幕并发调度
  const [frame, subtitles] = await Promise.all([
    Promise.resolve().then(() => captureCurrentFrame(0.8, video)),
    safeSubtitleContext(video),
  ]);

  return {
    image_base64: frame.image_base64,
    subtitles,
  };
}

/**
 * 采集 Payload 并经 chrome.runtime.sendMessage 交给 Background，等待响应。
 */
export async function requestAnalysis(): Promise<unknown> {
  const payload = await collectAnalysisPayload();
  const message: AnalyzeCodeMessage = { type: "ANALYZE_CODE", payload };
  return chrome.runtime.sendMessage(message);
}

/** DevTools 冒烟：Console 上下文切到本扩展 content script 后调用 */
declare global {
  interface Window {
    __freshvid?: {
      collectAnalysisPayload: typeof collectAnalysisPayload;
      requestAnalysis: typeof requestAnalysis;
    };
  }
}

window.__freshvid = { collectAnalysisPayload, requestAnalysis };
console.info(
  "[FreshVidCode] ready — Console 左上角上下文切到本扩展后执行:\n" +
    "  await __freshvid.collectAnalysisPayload()\n" +
    "  await __freshvid.requestAnalysis()",
);
