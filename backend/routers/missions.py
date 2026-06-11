"""
missions.py — FastAPI router for mission-related endpoints.

Registered in main.py under the ``/v1/missions`` prefix.

Endpoints
---------
POST /v1/missions/generate-mission
    Accept a MissionRequest, run the full lookup + test-generation pipeline,
    and return a MissionResponse.

GET  /v1/missions/
    List all statically registered missions (debug/admin use only).

Design rules
------------
- This file contains ONLY HTTP plumbing: validation, status codes, error
  mapping, and response construction.
- All business logic lives in ``backend.services``.
- All data lives in ``backend.repository``.
- All types live in ``backend.models``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from backend.models import MissionRequest, MissionResponse, SolutionRequest, SolutionResponse, FileAnalysisRequest, TierClassifyRequest, TierClassifyResponse
from backend.services import (
    lookup_mission,
    generate_hidden_test,
    enrich_mission,
    groq_service,
    resolve_primary_context,
    build_groq_context_block,
)
from backend.services.hidden_test_service import HiddenTestGenerationError
from backend.services.mission_service import LookupStatus, MissionLookupError
from backend.services import tier_classifier_service
from backend.repository import list_all

logger = logging.getLogger("zero_magic.router.missions")

router = APIRouter(
    prefix="/v1/missions",
    tags=["missions"],
)


# ---------------------------------------------------------------------------
# POST /v1/missions/generate-mission
# ---------------------------------------------------------------------------

@router.post(
    "/generate-mission",
    response_model=MissionResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate a Socratic mission for a given compiler error",
    description=(
        "Accepts the language, error code, and raw error message captured by "
        "the VS Code extension watcher. Returns a full ``MissionResponse`` "
        "containing the Socratic concept, questions, hints, and a hidden test "
        "payload to be written to ``.zero_magic/tests/``.\n\n"
        "**Flow**\n"
        "1. Validate the request body (Pydantic handles this automatically).\n"
        "2. Look up a static mission in the repository.\n"
        "3. Generate a hidden test (specific or fallback).\n"
        "4. If a static mission was found, merge its content with the generated "
        "test and return.\n"
        "5. If no static mission was found, return HTTP 404 so the extension "
        "can display a generic message (LLM generation is Phase 7 Step 6).\n"
    ),
    responses={
        200: {"description": "Mission found and returned successfully."},
        404: {"description": "No mission exists for this language/error combination."},
        422: {"description": "Request body failed validation (blank fields, etc.)."},
        500: {"description": "Unexpected internal error."},
    },
)
async def generate_mission(request_body: MissionRequest, request: Request) -> MissionResponse:
    """
    Full pipeline: validate → lookup → generate test → LLM enrich → respond.
    """
    request_id = _request_id(request)

    logger.info(
        "[%s] POST /generate-mission | language=%r  errorCode=%r  message=%r  "
        "hasTerminal=%s  exitCode=%s",
        request_id,
        request_body.language,
        request_body.errorCode,
        request_body.message[:60] + "…" if len(request_body.message) > 60 else request_body.message,
        bool(request_body.terminalOutput),
        request_body.exitCode,
    )

    # ── Context resolution (priority: terminalOutput > diagnosticMessage > errorCode) ──
    resolved = resolve_primary_context(
        error_code=request_body.errorCode,
        message=request_body.message,
        diagnostic_message=request_body.diagnosticMessage,
        terminal_output=request_body.terminalOutput,
        source_code=request_body.sourceCode,
    )
    logger.info(
        "[%s] Context resolved | source=%s  has_terminal=%s  has_code=%s",
        request_id,
        resolved.source.value,
        resolved.has_terminal,
        resolved.has_source_code,
    )

    # ── Step 1: Mission lookup ───────────────────────────────────────────────
    try:
        lookup_result = lookup_mission(
            language=request_body.language,
            error_code=request_body.errorCode,
        )
    except MissionLookupError as exc:
        # Blank / invalid fields that slipped past Pydantic (edge case)
        logger.warning("[%s] MissionLookupError: %s", request_id, exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    # ── Step 2: Hidden test generation ──────────────────────────────────────
    try:
        test_result = generate_hidden_test(
            language=request_body.language,
            error_code=request_body.errorCode,
            message=request_body.message,
        )
    except HiddenTestGenerationError as exc:
        logger.error("[%s] HiddenTestGenerationError: %s", request_id, exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    logger.debug(
        "[%s] Test generated | framework=%s  source=%s  chars=%d",
        request_id,
        test_result.framework,
        test_result.source,
        len(test_result.hidden_test),
    )

    # ── Step 3: Static mission found → build full MissionResponse ───────────
    if lookup_result.status is LookupStatus.FOUND and lookup_result.mission is not None:
        mission = lookup_result.mission  # MissionTemplate
        logger.info(
            "[%s] FOUND static mission | id=%r  title=%r",
            request_id,
            mission.mission_id,
            mission.title,
        )

        # ── Step 3a: Optional LLM enrichment (best-effort, never blocks) ────
        # enrich_mission() catches ALL exceptions internally and returns None
        # on any failure, so we never need a try/except here.
        enrichment = enrich_mission(
            language=request_body.language,
            error_code=request_body.errorCode,
            message=request_body.message,
        )

        if enrichment is not None:
            logger.info(
                "[%s] LLM enrichment applied | source=%s",
                request_id, enrichment.source,
            )
            # Append the contextual Q+hint to the static lists.
            # Static content always comes first so the Socratic flow stays
            # grounded in reviewed, pedagogically correct material.
            final_questions = list(mission.questions) + [enrichment.contextual_question]
            final_hints     = list(mission.hints)     + [enrichment.contextual_hint]
        else:
            logger.debug(
                "[%s] LLM enrichment unavailable — using repository content only.",
                request_id,
            )
            final_questions = list(mission.questions)
            final_hints     = list(mission.hints)

        return MissionResponse(
            missionId=mission.mission_id,
            title=mission.title,
            concept=mission.concept,
            questions=final_questions,
            hints=final_hints,
            # Always use the freshly generated test so the test-gen layer
            # stays as the single source of truth for runnable test code.
            framework=test_result.framework,
            hiddenTest=test_result.hidden_test,
        )

    # ── Step 4: No static mission → Generate dynamic mission via Groq ───────
    logger.info(
        "[%s] NOT_FOUND in static repository — calling Groq for dynamic mission",
        request_id,
    )

    dynamic_mission = groq_service.generate_dynamic_mission(
        language=request_body.language,
        error_code=request_body.errorCode,
        message=resolved.primary_text,
        source_code=request_body.sourceCode,
        terminal_output=request_body.terminalOutput,
        exit_code=request_body.exitCode,
    )

    # Create a stable, safe missionId for the extension's file management
    import re
    raw_id = f"dynamic_{request_body.language}_{request_body.errorCode}"
    mission_id = re.sub(r'[^a-z0-9_]', '_', raw_id.lower())

    return MissionResponse(
        missionId=mission_id,
        title="Custom Socratic Mission",
        concept=dynamic_mission.concept,
        questions=dynamic_mission.questions,
        hints=dynamic_mission.hints,
        framework=test_result.framework,
        hiddenTest=test_result.hidden_test,
    )


# ---------------------------------------------------------------------------
# GET /v1/missions/ — debug / admin listing
# ---------------------------------------------------------------------------

@router.get(
    "/",
    summary="List all registered static missions",
    description=(
        "Returns every mission currently loaded in the static repository. "
        "Intended for debugging and admin use — not called by the VS Code extension."
    ),
    status_code=status.HTTP_200_OK,
)
async def list_missions() -> dict[str, Any]:
    """Return a summary of all statically registered missions."""
    missions = list_all()
    logger.debug("GET /v1/missions/ | returning %d missions", len(missions))
    return {
        "count": len(missions),
        "missions": [
            {
                "missionId": m.mission_id,
                "language":  m.language,
                "errorCode": m.error_code,
                "title":     m.title,
                "framework": m.framework,
            }
            for m in missions
        ],
    }


# ---------------------------------------------------------------------------
# POST /v1/missions/reveal-solution
# ---------------------------------------------------------------------------

@router.post(
    "/reveal-solution",
    response_model=SolutionResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate an expert solution based on user's code and error",
)
async def reveal_solution(request_body: SolutionRequest, request: Request) -> SolutionResponse:
    request_id = _request_id(request)
    logger.info(
        "[%s] POST /reveal-solution | language=%r  errorCode=%r",
        request_id,
        request_body.language,
        request_body.errorCode,
    )

    result = groq_service.generate_expert_solution(
        language=request_body.language,
        error_code=request_body.errorCode,
        source_code=request_body.sourceCode,
        message=request_body.diagnosticMessage,
    )

    return SolutionResponse(
        fixedCode=result.fixedCode,
        explanation=result.explanation,
        conceptSummary=result.conceptSummary
    )


# ---------------------------------------------------------------------------
# POST /v1/missions/analyze-file
# ---------------------------------------------------------------------------

@router.post(
    "/analyze-file",
    response_model=MissionResponse,
    status_code=status.HTTP_200_OK,
    summary="Analyze full file and generate a Socratic mission",
)
async def analyze_file(request_body: FileAnalysisRequest, request: Request) -> MissionResponse:
    request_id = _request_id(request)
    logger.info(
        "[%s] POST /analyze-file | language=%r length=%d",
        request_id,
        request_body.language,
        len(request_body.fullCode),
    )

    dynamic_mission = groq_service.generate_file_mission(
        language=request_body.language,
        full_code=request_body.fullCode,
    )

    import re
    raw_id = f"file_{request_body.language}_{hash(request_body.fullCode) % 10000}"
    mission_id = re.sub(r'[^a-z0-9_]', '_', raw_id.lower())

    return MissionResponse(
        missionId=mission_id,
        title="Full Program Analysis",
        concept=dynamic_mission.concept,
        questions=dynamic_mission.questions,
        hints=dynamic_mission.hints,
        framework="pytest" if request_body.language.lower() == "python" else "jest",
        hiddenTest="def test_file_analysis_placeholder():\n    assert True, 'File analysis complete'",
    )


# ---------------------------------------------------------------------------
# POST /v1/missions/classify-tier  — Groq-powered tier router
# ---------------------------------------------------------------------------

@router.post(
    "/classify-tier",
    response_model=TierClassifyResponse,
    status_code=status.HTTP_200_OK,
    summary="Classify error severity tier using GROQ_API_KEY1",
    description=(
        "Accepts error context from the VS Code extension and returns a tier "
        "classification (1 / 2 / 3) that drives which sidebar card to render.\n\n"
        "**Decision order**\n"
        "1. Regex fast-path — SyntaxError / traceback patterns → instant result.\n"
        "2. LLM (GROQ_API_KEY1) — semantic analysis for ambiguous errors.\n"
        "3. Safe fallback → Tier 2 (always shows the analysis card).\n\n"
        "**Tiers**\n"
        "- Tier 1: Syntax / Import / Typo → lightweight nudge card, no Deep Dive.\n"
        "- Tier 2: Logic / Type / Async → analysis card + opt-in Deep Dive button.\n"
        "- Tier 3: Runtime crash / traceback → auto-trigger Deep Dive."
    ),
    responses={
        200: {"description": "Tier classification result."},
        422: {"description": "Request body failed validation."},
        500: {"description": "Unexpected internal error."},
    },
)
async def classify_tier(
    request_body: TierClassifyRequest,
    request: Request,
) -> TierClassifyResponse:
    """Classify an error diagnostic into Tier 1, 2, or 3."""
    request_id = _request_id(request)

    logger.info(
        "[%s] POST /classify-tier | language=%r  errorCode=%r  line=%d  "
        "hasTerminal=%s",
        request_id,
        request_body.language,
        request_body.errorCode,
        request_body.lineNumber,
        bool(request_body.terminalOutput),
    )

    result = tier_classifier_service.classify_error_tier(
        language=request_body.language,
        error_code=request_body.errorCode,
        message=request_body.message,
        terminal_output=request_body.terminalOutput,
        source_code=request_body.sourceCode,
        line_number=request_body.lineNumber,
    )

    logger.info(
        "[%s] Tier classified: tier=%d  source=%s  flag=%r",
        request_id,
        result.tier,
        result.source,
        result.error_flag[:60],
    )

    return TierClassifyResponse(
        tier=result.tier,
        errorFlag=result.error_flag,
        proTip=result.pro_tip,
        explanation=result.explanation,
        source=result.source,
        apiUsed=result.api_used,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _request_id(request: Request) -> str:
    """
    Extract a short, loggable request identifier.
    Uses the ``X-Request-ID`` header if the client/proxy sets one,
    otherwise falls back to the client host + port.
    """
    rid = request.headers.get("x-request-id")
    if rid:
        return rid[:16]
    client = request.client
    return f"{client.host}:{client.port}" if client else "unknown"
