from enum import Enum
from typing import List
from pydantic import BaseModel, HttpUrl


class SubtitleSegment(BaseModel):
    timestamp: str
    text: str


class SubtitleContext(BaseModel):
    current_timestamp: str
    segments: List[SubtitleSegment]


class AnalysisPayload(BaseModel):
    image_base64: str
    subtitles: SubtitleContext


class CodeInfo(BaseModel):
    language: str
    library: str | None = None
    symbol: str | None = None
    code: str


class SearchResultItem(BaseModel):
    title: str
    url: str
    domain: str
    snippet: str


class VerificationStatus(str, Enum):
    VALID = "valid"
    OUTDATED = "outdated"
    UNKNOWN = "unknown"


class VerificationResult(BaseModel):
    status: VerificationStatus
    recommended_syntax: str | None = None
    reason: str
    quote: str | None = None
    source_url: HttpUrl | None = None
