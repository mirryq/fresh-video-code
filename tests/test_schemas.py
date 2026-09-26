import pytest
from pydantic import ValidationError

from schemas import (
    AnalysisPayload,
    CodeInfo,
    SearchResultItem,
    SubtitleContext,
    SubtitleSegment,
    VerificationResult,
    VerificationStatus,
)


class TestSubtitleSegment:
    def test_valid_parse(self):
        seg = SubtitleSegment(timestamp="00:01:23", text="Hello world")
        assert seg.timestamp == "00:01:23"
        assert seg.text == "Hello world"

    def test_rejects_non_string_fields(self):
        with pytest.raises(ValidationError):
            SubtitleSegment(timestamp=123, text="ok")


class TestSubtitleContext:
    def test_valid_parse(self):
        ctx = SubtitleContext(
            current_timestamp="00:01:23",
            segments=[
                SubtitleSegment(timestamp="00:01:20", text="prev"),
                {"timestamp": "00:01:23", "text": "now"},
            ],
        )
        assert ctx.current_timestamp == "00:01:23"
        assert len(ctx.segments) == 2
        assert ctx.segments[1].text == "now"

    def test_rejects_invalid_segment_item(self):
        with pytest.raises(ValidationError):
            SubtitleContext(
                current_timestamp="00:00:01",
                segments=[{"timestamp": "00:00:01"}],  # missing text
            )


class TestAnalysisPayload:
    def test_valid_parse(self):
        payload = AnalysisPayload(
            image_base64="abc123",
            subtitles={
                "current_timestamp": "00:00:10",
                "segments": [{"timestamp": "00:00:10", "text": "code"}],
            },
        )
        assert payload.image_base64 == "abc123"
        assert payload.subtitles.segments[0].text == "code"

    def test_rejects_non_object_subtitles(self):
        with pytest.raises(ValidationError):
            AnalysisPayload(image_base64="abc", subtitles="not-a-context")


class TestCodeInfo:
    def test_valid_parse_with_all_fields(self):
        info = CodeInfo(
            language="python",
            library="pydantic",
            symbol="BaseModel",
            code="class Foo(BaseModel): pass",
        )
        assert info.language == "python"
        assert info.library == "pydantic"
        assert info.symbol == "BaseModel"
        assert "BaseModel" in info.code

    def test_defaults_for_optional_fields(self):
        info = CodeInfo(language="python", code="print(1)")
        assert info.library is None
        assert info.symbol is None

    def test_rejects_non_string_code(self):
        with pytest.raises(ValidationError):
            CodeInfo(language="python", code=12345)


class TestSearchResultItem:
    def test_valid_parse(self):
        item = SearchResultItem(
            title="Docs",
            url="https://example.com/docs",
            domain="example.com",
            snippet="Official documentation",
        )
        assert item.title == "Docs"
        assert item.url == "https://example.com/docs"
        assert item.domain == "example.com"
        assert item.snippet == "Official documentation"

    def test_rejects_missing_required_field(self):
        with pytest.raises(ValidationError):
            SearchResultItem(
                title="Docs",
                url="https://example.com",
                domain="example.com",
            )


class TestVerificationResult:
    def test_valid_parse_with_all_fields(self):
        result = VerificationResult(
            status=VerificationStatus.VALID,
            recommended_syntax="model_validate",
            reason="Matches current API",
            quote="Use model_validate instead",
            source_url="https://docs.pydantic.dev/latest/",
        )
        assert result.status is VerificationStatus.VALID
        assert result.recommended_syntax == "model_validate"
        assert result.reason == "Matches current API"
        assert result.quote == "Use model_validate instead"
        assert str(result.source_url) == "https://docs.pydantic.dev/latest/"

    def test_defaults_for_optional_fields(self):
        result = VerificationResult(
            status="outdated",
            reason="API changed",
        )
        assert result.status is VerificationStatus.OUTDATED
        assert result.recommended_syntax is None
        assert result.quote is None
        assert result.source_url is None

    def test_rejects_undefined_enum(self):
        with pytest.raises(ValidationError):
            VerificationResult(status="broken", reason="bad status")

    def test_rejects_invalid_url(self):
        with pytest.raises(ValidationError):
            VerificationResult(
                status=VerificationStatus.UNKNOWN,
                reason="cannot verify",
                source_url="not-a-url",
            )
