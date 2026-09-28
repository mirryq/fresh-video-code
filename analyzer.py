import json

from zai import ZhipuAiClient

from schemas import AnalysisPayload, CodeInfo

EXTRACT_MODEL = "glm-4.6v-flash"


class ExtractRetryError(ValueError):
    """无代码或图片模糊，提示用户重试。"""


def parse_extract_response(text: str) -> CodeInfo:
    """解析模型原始文本：成功/遮挡 → CodeInfo；无代码/模糊 → 请重试。"""
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError) as e:
        raise ValueError(f"模型没有返回 JSON: {text}") from e

    status = data.get("status") if isinstance(data, dict) else None
    if status in {"no_code", "blurry"}:
        reason = (
            "当前画面中没有代码"
            if status == "no_code"
            else "图片模糊，无法可靠识别代码"
        )
        raise ExtractRetryError(f"{reason}，请重试")
    if status not in {"ok", "occluded"}:
        raise ValueError(f"无法识别的抽取结果: {status!r}")

    return CodeInfo.model_validate(data)


def call_extract_model(payload: AnalysisPayload, client: ZhipuAiClient) -> str:
    """调用 glm-4.6v-flash，返回模型原始文本。"""
    current = payload.subtitles.current_timestamp
    if payload.subtitles.segments:
        primary_timestamp = max(
            (
                segment.timestamp
                for segment in payload.subtitles.segments
                if segment.timestamp <= current
            ),
        )
        subtitle_lines = []
        for segment in payload.subtitles.segments:
            role = "主依据" if segment.timestamp == primary_timestamp else "辅助"
            subtitle_lines.append(
                f"- [{role}] {segment.timestamp}: {segment.text}")
        subtitle_block = "\n".join(subtitle_lines)
    else:
        subtitle_block = "（无字幕）"

    prompt = f"""只做代码提取，不要判断代码是否过期，不要给推荐写法。

【依据优先级】
1. 主依据：当前视频画面 + 标注为「主依据」的字幕（当前时间戳 {current}）
2. 辅助：标注为「辅助」的字幕，仅作上下文，不得覆盖画面与主字幕的结论

【字幕】
{subtitle_block}

【任务】
结合画面与字幕，定位讲师当前正在编写或讲解的核心代码，并抽取元数据。

【结果约定】
只输出一个 JSON 对象，不要输出其他文字。按情况选择其一：

1. 完整可识别：
{{"status":"ok","language":"...","library":"...或 null","symbol":"...或 null","code":"..."}}

2. 当前画面中没有代码：
{{"status":"no_code"}}

3. 图片模糊，无法可靠识别：
{{"status":"blurry"}}

4. 代码被遮挡：只输出可见部分；被挡处用 █ 占位；禁止补全或猜测被挡内容：
{{"status":"occluded","language":"...","library":"...或 null","symbol":"...或 null","code":"可见部分与█占位"}}
"""

    response = client.chat.completions.create(
        model=EXTRACT_MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": payload.image_base64},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        thinking={"type": "enabled"},
        reasoning_effort="low",
        temperature=0.1,
        max_tokens=1024,
        response_format={"type": "json_object"},
    )
    content = response.choices[0].message.content
    return content
