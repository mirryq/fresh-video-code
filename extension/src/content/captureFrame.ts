/**
 * YouTube Content Script — 当前视频帧截取
 * 输出字段对齐 schemas.AnalysisPayload.image_base64（JPEG Data URL）
 */

export type CaptureFrameResult = {
  /** JPEG Data URL，可直接填入 AnalysisPayload.image_base64 */
  image_base64: string;
  width: number;
  height: number;
};

export class CaptureFrameError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NO_VIDEO"
      | "NOT_READY"
      | "ZERO_SIZE"
      | "CORS_TAINTED"
      | "UNKNOWN",
  ) {
    super(message);
    this.name = "CaptureFrameError";
  }
}

/**
 * 寻找页面上的活动 <video>（优先 YouTube .html5-main-video）。
 * 不在此处强制 readyState，由 captureCurrentFrame 统一校验并给出明确错误。
 */
export function findActiveVideo(
  root: ParentNode = document,
): HTMLVideoElement | null {
  const main = root.querySelector<HTMLVideoElement>(
    "video.html5-main-video, .html5-video-player video.html5-main-video, .html5-video-player video",
  );
  if (main) return main;

  const candidates = Array.from(root.querySelectorAll("video")).filter(
    (v) => v instanceof HTMLVideoElement && videoVisibleArea(v) > 0,
  );
  if (candidates.length === 0) return null;

  // 面积最大且可见的视为当前活动视频
  return candidates.reduce((best, cur) =>
    videoVisibleArea(cur) > videoVisibleArea(best) ? cur : best,
  );
}

function videoVisibleArea(video: HTMLVideoElement): number {
  const rect = video.getBoundingClientRect();
  const style = getComputedStyle(video);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number(style.opacity) === 0
  ) {
    return 0;
  }
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/**
 * 截取当前帧为 JPEG Data URL，供 AnalysisPayload.image_base64 使用。
 *
 * @param quality JPEG 压缩质量，默认 0.8
 * @param video   可选；不传则自动寻找活动视频
 */
export function captureCurrentFrame(
  quality = 0.8,
  video?: HTMLVideoElement | null,
): CaptureFrameResult {
  const target = video ?? findActiveVideo();
  if (!target) {
    throw new CaptureFrameError(
      "未找到可用的 <video> 元素（请确认在 YouTube 播放页，且播放器已加载）。",
      "NO_VIDEO",
    );
  }

  // HAVE_CURRENT_DATA = 2：当前帧数据已就绪
  if (target.readyState < 2) {
    throw new CaptureFrameError(
      `视频尚未就绪播放（readyState=${target.readyState}，需要 >= 2）。请等待缓冲或先播放片刻。`,
      "NOT_READY",
    );
  }

  const width = target.videoWidth;
  const height = target.videoHeight;
  if (!width || !height) {
    throw new CaptureFrameError(
      "视频物理分辨率为 0，无法截取（可能仍在加载）。",
      "ZERO_SIZE",
    );
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.display = "none";

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new CaptureFrameError("无法创建 Canvas 2D 上下文。", "UNKNOWN");
  }

  try {
    ctx.drawImage(target, 0, 0, width, height);
  } catch (err) {
    throw new CaptureFrameError(
      `绘制视频帧失败: ${err instanceof Error ? err.message : String(err)}`,
      "UNKNOWN",
    );
  }

  let image_base64: string;
  try {
    // data:image/jpeg;base64,... — 对齐 schemas.AnalysisPayload.image_base64
    image_base64 = canvas.toDataURL("image/jpeg", quality);
  } catch (err) {
    // SecurityError: canvas 被跨域污染（CORS Tainted）
    const msg = err instanceof Error ? err.message : String(err);
    throw new CaptureFrameError(
      `Canvas 跨域污染（CORS Tainted），无法导出帧。` +
        `请确认 video 资源允许跨域读取（crossOrigin / CORS）。原始错误: ${msg}` +
        ` | 降级建议: 改用 chrome.tabs.captureVisibleTab 截取可见标签页，或由 background 代理抓取同源媒体。`,
      "CORS_TAINTED",
    );
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }

  if (!image_base64.startsWith("data:image/jpeg;base64,")) {
    throw new CaptureFrameError(
      "toDataURL 未返回预期的 JPEG Data URL。",
      "UNKNOWN",
    );
  }

  return { image_base64, width, height };
}

/**
 * 组装可直接填入 AnalysisPayload.image_base64 的字段。
 */
export function buildImagePayload(quality = 0.8): { image_base64: string } {
  const { image_base64 } = captureCurrentFrame(quality);
  return { image_base64 };
}
