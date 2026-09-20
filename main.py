import base64
import json
import os
import time
from dataclasses import dataclass

from dotenv import load_dotenv
from zai import ZhipuAiClient
from zai.core import APIStatusError


load_dotenv()

api_key = os.environ.get("API_KEY")
if not api_key:
    raise SystemExit("请在 .env 中配置 API_KEY")

client = ZhipuAiClient(api_key=api_key)

EXTRACT_MODEL = "glm-4.6v-flash"
JUDGE_MODEL = "glm-5.2"

image_path = "test.png"
subtitles_context = (
    "... instructions using a file called Docker dash compose dot YML. And so this is a YAML file. And if you don't know too much about YAML, it's just a, I guess, technically, like a markup language, I guess. But the most important thing to understand is that spacing matters. So this is kind of like Python, where you need to make sure that the tabs and the spaces are just right, and everything lines up, or then it's going to start to throw errors. And the first thing that we need to do is specify what version of Docker compose we want to use. So we say version. And I'm going to say just version three, it's not the latest, it's just come most common one. If you actually go to the Docker documentation for compose file, you'll see the different versions that you can specify. And you can actually take a look at the documentation and see what feature was introduced in what version so you can figure out what version you need to perform all of your operations, we're not doing anything special. So version three is just fine for us. Then within Docker compose, we have a concept of services. And so a service, really, at the heart of it is nothing more than just a container. So if you want Docker compose to spin you up a container, you have to define a service. If you want Docker compose to spin up..."
)


@dataclass
class Extraction:
    library: str
    symbol: str
    code: str
    language: str


@dataclass
class Source:
    title: str
    url: str
    snippet: str


@dataclass
class Verdict:
    status: str
    analysis: str
    recommended: str
    citations: list[str]


def call_with_retry(fn):
    retry_delay = 5
    for attempt in range(5):
        try:
            return fn()
        except APIStatusError as e:
            print(f"请求失败 ({e.status_code}): {e}")
            if attempt < 4 and e.status_code in (500, 503):
                print(f"等待 {retry_delay} 秒后重试...")
                time.sleep(retry_delay)
                retry_delay *= 2
                continue
            raise


def parse_json_object(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        text = text.rsplit("```", 1)[0]
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"模型没有返回 JSON: {text}")
    return json.loads(text[start: end + 1])


def extract_code(image_base64: str, subtitles: str) -> Extraction:
    prompt = f"""
只做代码提取，不要判断这段代码是否过期，不要给推荐写法。

【口述字幕】:
{subtitles}

结合字幕，找出讲师当前正在编写或讲解的核心代码，以及它所属的库或工具。
只输出一个 JSON 对象，不要输出其他文字：
{{
  "library": "库或工具名",
  "symbol": "正在讲解的关键字段、类或函数名",
  "code": "截图中的原始代码，显示不全时用字幕补全",
  "language": "语言或格式，如 python / yaml"
}}
"""
    response = call_with_retry(
        lambda: client.chat.completions.create(
            model=EXTRACT_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": image_base64},
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
    )
    data = parse_json_object(response.choices[0].message.content)
    return Extraction(
        library=str(data.get("library", "")).strip(),
        symbol=str(data.get("symbol", "")).strip(),
        code=str(data.get("code", "")).strip(),
        language=str(data.get("language", "")).strip(),
    )


def search_evidence(extraction: Extraction) -> list[Source]:
    code = " ".join(extraction.code.split())
    if len(code) > 80:
        code = code[:80]
    query = (
        f"{extraction.library} {extraction.symbol} {code} "
        "deprecated OR obsolete official documentation"
    ).strip()
    response = call_with_retry(
        lambda: client.web_search.web_search(
            search_engine="search_pro",
            search_query=query,
            search_intent=False,
            count=5,
            search_recency_filter="noLimit",
            content_size="high",
        )
    )
    raw = response.search_result or []
    items = raw if isinstance(raw, list) else [raw]
    sources = []
    for item in items:
        title = getattr(item, "title", "") or ""
        url = getattr(item, "link", "") or ""
        snippet = getattr(item, "content", "") or ""
        if title or url or snippet:
            sources.append(Source(title=title, url=url, snippet=snippet))
    return sources[:5]


def judge(extraction: Extraction, sources: list[Source]) -> Verdict:
    if sources:
        evidence = "\n\n".join(
            f"[{i}] {source.title}\n{source.url}\n{source.snippet}"
            for i, source in enumerate(sources, start=1)
        )
    else:
        evidence = "（没有检索到任何结果）"

    prompt = f"""
你是代码时效性判定员。你不能看截图，也不能凭训练记忆下结论。
只能根据下面的【提取结果】和【检索材料】判断。

【提取结果】
库或工具: {extraction.library}
关键符号: {extraction.symbol}
代码:
{extraction.code}
语言: {extraction.language}

【检索材料】
{evidence}

规则：
1. 只有检索材料里有明确原文支持时，才能输出「已过期」或「未过期」。
2. 「已过期」包括：官方已废弃、字段或签名已移除、文档明确说不要再写。
3. 材料不足以支持任何一边时，status 必须是「无法核验」。不要把记忆里的常见写法当成未过期。
4. citations 必须是材料中的原句，并带上来源编号，例如 "[1] ..."。无法核验时 citations 为空数组。

只输出一个 JSON 对象：
{{
  "status": "已过期 或 未过期 或 无法核验",
  "analysis": "判定理由，指出依据的是哪一条材料",
  "recommended": "若已过期，给出材料支持的现代写法；否则写无",
  "citations": ["[1] 引用的原句"]
}}
"""
    response = call_with_retry(
        lambda: client.chat.completions.create(
            model=JUDGE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            thinking={"type": "enabled"},
            reasoning_effort="high",
            temperature=0.1,
            max_tokens=2048,
            response_format={"type": "json_object"},
        )
    )
    data = parse_json_object(response.choices[0].message.content)
    status = str(data.get("status", "")).strip()
    if status not in {"已过期", "未过期", "无法核验"}:
        status = "无法核验"
    citations = data.get("citations") or []
    if not isinstance(citations, list):
        citations = [str(citations)]
    return Verdict(
        status=status,
        analysis=str(data.get("analysis", "")).strip(),
        recommended=str(data.get("recommended", "")).strip(),
        citations=[str(item).strip()
                   for item in citations if str(item).strip()],
    )


def cited_sources(sources: list[Source], citations: list[str]) -> list[Source]:
    indexes = []
    for citation in citations:
        for number in citation.replace("[", " [").split("["):
            digits = ""
            for char in number:
                if char.isdigit():
                    digits += char
                else:
                    break
            if digits:
                indexes.append(int(digits))
    picked = []
    seen = set()
    for index in indexes:
        if index in seen or not 1 <= index <= len(sources):
            continue
        seen.add(index)
        picked.append(sources[index - 1])
    return picked


def main() -> None:
    with open(image_path, "rb") as img_file:
        image_base64 = base64.b64encode(img_file.read()).decode("utf-8")

    print("1/3 提取截图中的代码...")
    extraction = extract_code(image_base64, subtitles_context)
    print(f"库: {extraction.library}")
    print(f"符号: {extraction.symbol}")
    print(f"代码: {extraction.code}")

    print("\n2/3 检索官方材料...")
    sources = search_evidence(extraction)
    if not sources:
        print("没有检索结果")
    for i, source in enumerate(sources, start=1):
        print(f"[{i}] {source.title}")
        print(f"    {source.url}")

    print("\n3/3 根据检索材料判定...")
    verdict = judge(extraction, sources)

    print("\n" + "=" * 40)
    print("【识别到的代码】")
    print(extraction.code)
    print("\n【时效状态】")
    print(verdict.status)
    print("\n【判定分析】")
    print(verdict.analysis)
    print("\n【最新推荐写法】")
    print(verdict.recommended or "无")
    print("\n【官方参考链接】")
    cited = cited_sources(sources, verdict.citations)
    if cited and verdict.status != "无法核验":
        for source in cited:
            print(f"- {source.title}: {source.url}")
    else:
        print("无")
    if verdict.citations:
        print("\n【引用原句】")
        for citation in verdict.citations:
            print(f"- {citation}")
    print("=" * 40)


if __name__ == "__main__":
    main()
