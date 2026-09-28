import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from pydantic import ValidationError
from zai.core import APIStatusError, APITimeoutError

from analyzer import ExtractRetryError, call_extract_model, parse_extract_response
from schemas import AnalysisPayload


def _sample_payload(**overrides) -> AnalysisPayload:
    data = {
        "image_base64": "data:image/jpeg;base64,/9j/fake",
        "subtitles": {
            "current_timestamp": "00:01:23",
            "segments": [
                {"timestamp": "00:01:20", "text": "先看这里"},
                {"timestamp": "00:01:23", "text": "这个 BaseModel"},
                {"timestamp": "00:01:25", "text": "接着往下"},
            ],
        },
    }
    data.update(overrides)
    return AnalysisPayload(**data)


def _mock_client(content: str = '{"status":"ok"}') -> MagicMock:
    client = MagicMock()
    client.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
    )
    return client


class TestCallExtractModel:
    def test_returns_model_content(self):
        content = json.dumps({"status": "ok", "language": "python", "code": "x=1"})
        result = call_extract_model(_sample_payload(), _mock_client(content))
        assert result == content

    def test_prompt_marks_primary_when_pause_between_timestamps(self):
        payload = _sample_payload(
            subtitles={
                "current_timestamp": "00:01:24",
                "segments": [
                    {"timestamp": "00:01:20", "text": "先看这里"},
                    {"timestamp": "00:01:23", "text": "这个 BaseModel"},
                    {"timestamp": "00:01:25", "text": "接着往下"},
                ],
            }
        )
        client = _mock_client()
        call_extract_model(payload, client)

        prompt = client.chat.completions.create.call_args.kwargs["messages"][0][
            "content"
        ][1]["text"]
        assert "[主依据] 00:01:23: 这个 BaseModel" in prompt
        assert "[辅助] 00:01:20: 先看这里" in prompt
        assert "[辅助] 00:01:25: 接着往下" in prompt

    def test_api_5xx_raises(self):
        client = MagicMock()
        client.chat.completions.create.side_effect = APIStatusError(
            "service unavailable",
            response=httpx.Response(
                503,
                request=httpx.Request("POST", "https://api.example.com/chat"),
            ),
        )
        with pytest.raises(APIStatusError) as exc_info:
            call_extract_model(_sample_payload(), client)
        assert exc_info.value.status_code == 503

    def test_api_timeout_raises(self):
        client = MagicMock()
        client.chat.completions.create.side_effect = APITimeoutError(
            request=httpx.Request("POST", "https://api.example.com/chat"),
        )
        with pytest.raises(APITimeoutError):
            call_extract_model(_sample_payload(), client)


class TestParseExtractResponse:
    def test_ok_returns_code_info(self):
        info = parse_extract_response(
            json.dumps(
                {
                    "status": "ok",
                    "language": "python",
                    "library": "pydantic",
                    "symbol": "BaseModel",
                    "code": "class Foo(BaseModel): pass",
                }
            )
        )
        assert info.language == "python"
        assert info.library == "pydantic"
        assert info.symbol == "BaseModel"
        assert "BaseModel" in info.code

    def test_occluded_keeps_placeholders(self):
        info = parse_extract_response(
            json.dumps(
                {
                    "status": "occluded",
                    "language": "python",
                    "code": "def foo(███):\n    pass",
                }
            )
        )
        assert info.library is None
        assert info.symbol is None
        assert "███" in info.code

    def test_no_code_asks_retry(self):
        with pytest.raises(ExtractRetryError, match="请重试"):
            parse_extract_response('{"status":"no_code"}')

    def test_blurry_asks_retry(self):
        with pytest.raises(ExtractRetryError, match="请重试"):
            parse_extract_response('{"status":"blurry"}')

    def test_rejects_non_json(self):
        with pytest.raises(ValueError, match="JSON"):
            parse_extract_response("不是 JSON")

    def test_rejects_unknown_status(self):
        with pytest.raises(ValueError, match="无法识别"):
            parse_extract_response('{"status":"weird"}')

    def test_rejects_invalid_code_info_fields(self):
        with pytest.raises(ValidationError):
            parse_extract_response(
                '{"status":"ok","language":"python","code":12345}'
            )
