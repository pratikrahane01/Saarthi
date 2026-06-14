"""
sandbox.py — FastAPI router for Tier 3 Sandbox endpoints.

Registered in main.py under the ``/v1/sandbox`` prefix.

Endpoints
---------
POST /v1/sandbox/generate
    Generate a sandbox challenge for a Tier 3 logic bug.

POST /v1/sandbox/evaluate
    Evaluate a student's sandbox submission.

ISOLATION RULE: This router is completely independent of missions.py.
It uses its own models (sandbox_models.py) and its own service
(sandbox_service.py). It does NOT import from or modify any existing
Tier 1/Tier 2 endpoint.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request, status

from backend.models.sandbox_models import (
    SandboxGenerateRequest,
    SandboxGenerateResponse,
    SandboxEvaluateRequest,
    SandboxEvaluateResponse,
)
from backend.services.sandbox_service import (
    generate_sandbox_challenge,
    evaluate_sandbox_submission,
)

logger = logging.getLogger("zero_magic.router.sandbox")

router = APIRouter(
    prefix="/v1/sandbox",
    tags=["sandbox"],
)


# ---------------------------------------------------------------------------
# POST /v1/sandbox/generate
# ---------------------------------------------------------------------------

@router.post(
    "/generate",
    response_model=SandboxGenerateResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate a Tier 3 sandbox challenge",
    description=(
        "Accepts the source code and error context from a Tier 3 logic bug "
        "and returns a Socratic sandbox challenge for the student to solve.\n\n"
        "**Flow**\n"
        "1. Validate the request body.\n"
        "2. Call sandbox_service.generate_sandbox_challenge().\n"
        "3. Return the challenge with hints and success criteria.\n"
    ),
    responses={
        200: {"description": "Sandbox challenge generated successfully."},
        422: {"description": "Request body failed validation."},
        500: {"description": "Unexpected internal error."},
    },
)
async def generate_sandbox(
    request_body: SandboxGenerateRequest,
    request: Request,
) -> SandboxGenerateResponse:
    """Generate a sandbox challenge for a Tier 3 logic bug."""
    request_id = _request_id(request)

    logger.info(
        "[%s] POST /sandbox/generate | language=%r  errorContext=%r  codeLen=%d",
        request_id,
        request_body.language,
        request_body.errorContext[:60] + "…" if len(request_body.errorContext) > 60 else request_body.errorContext,
        len(request_body.sourceCode),
    )

    result = generate_sandbox_challenge(request_body)

    logger.info(
        "[%s] Sandbox challenge generated | sandboxId=%r",
        request_id,
        result.sandboxId,
    )

    return result


# ---------------------------------------------------------------------------
# POST /v1/sandbox/evaluate
# ---------------------------------------------------------------------------

@router.post(
    "/evaluate",
    response_model=SandboxEvaluateResponse,
    status_code=status.HTTP_200_OK,
    summary="Evaluate a student's sandbox submission",
    description=(
        "Accepts the student's modified code and evaluates whether the "
        "Tier 3 logic bug has been fixed.\n\n"
        "**Flow**\n"
        "1. Validate the request body.\n"
        "2. Call sandbox_service.evaluate_sandbox_submission().\n"
        "3. Return pass/fail result with Socratic feedback.\n"
    ),
    responses={
        200: {"description": "Evaluation result returned."},
        422: {"description": "Request body failed validation."},
        500: {"description": "Unexpected internal error."},
    },
)
async def evaluate_sandbox(
    request_body: SandboxEvaluateRequest,
    request: Request,
) -> SandboxEvaluateResponse:
    """Evaluate a student's sandbox submission."""
    request_id = _request_id(request)

    logger.info(
        "[%s] POST /sandbox/evaluate | sandboxId=%r  language=%r",
        request_id,
        request_body.sandboxId,
        request_body.language,
    )

    result = evaluate_sandbox_submission(request_body)

    logger.info(
        "[%s] Sandbox evaluation complete | passed=%s  xp=%d",
        request_id,
        result.passed,
        result.xpAwarded,
    )

    return result


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _request_id(request: Request) -> str:
    """
    Extract a short, loggable request identifier.
    Uses the ``X-Request-ID`` header if set, otherwise falls back to client host:port.
    """
    rid = request.headers.get("x-request-id")
    if rid:
        return rid[:16]
    client = request.client
    return f"{client.host}:{client.port}" if client else "unknown"
