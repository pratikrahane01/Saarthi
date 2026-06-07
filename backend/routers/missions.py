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

from backend.models import MissionRequest, MissionResponse
from backend.services import (
    lookup_mission,
    generate_hidden_test,
    enrich_mission,
)
from backend.services.mission_service import LookupStatus, MissionLookupError
from backend.services.hidden_test_service import HiddenTestGenerationError
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
        "[%s] POST /generate-mission | language=%r  errorCode=%r  message=%r",
        request_id,
        request_body.language,
        request_body.errorCode,
        request_body.message[:60] + "…" if len(request_body.message) > 60 else request_body.message,
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

    # ── Step 4: No static mission → 404 (LLM fallback is Phase 7 Step 6) ───
    logger.warning(
        "[%s] NOT_FOUND | language=%r  errorCode=%r — returning 404",
        request_id,
        request_body.language,
        request_body.errorCode,
    )
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=(
            f"No Socratic mission found for language={request_body.language!r} "
            f"and errorCode={request_body.errorCode!r}. "
            "LLM-based generation will be added in a future phase."
        ),
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
