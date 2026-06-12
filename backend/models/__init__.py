# models package — Pydantic schemas for the Zero-Magic backend API.
# Import from this package to access request/response contracts.

from .schemas import (
    MissionRequest,
    MissionResponse,
    SolutionRequest,
    SolutionResponse,
    FileAnalysisRequest,
    TierClassifyRequest,
    TierClassifyResponse,
    RitualContextRequest,
    RitualContextResponse,
    ErrorLine,
    AnalyzeErrorsRequest,
    ErrorRegion,
    AnalyzeErrorsResponse,
)

__all__ = [
    "MissionRequest",
    "MissionResponse",
    "SolutionRequest",
    "SolutionResponse",
    "FileAnalysisRequest",
    "TierClassifyRequest",
    "TierClassifyResponse",
    "RitualContextRequest",
    "RitualContextResponse",
    "ErrorLine",
    "AnalyzeErrorsRequest",
    "ErrorRegion",
    "AnalyzeErrorsResponse",
]
