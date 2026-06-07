"""
mission_service.py — Business logic layer for Zero-Magic mission lookups.

Sits between the repository (data) and the router (HTTP). Its only job is:
  1. Validate and sanitise incoming input.
  2. Delegate to the repository for the actual lookup.
  3. Return a structured, typed result with full audit trail.
  4. Log every decision so the team can trace what happened and why.

This module has NO FastAPI imports. It can be called from:
  - A FastAPI route handler (Phase 7 Step 4)
  - A CLI debug script
  - A unit test
  - A future async worker

Flow diagram
------------

  caller
    │
    ▼
  lookup_mission(language, error_code)
    │
    ├─► [validate] blank / whitespace-only inputs → raise MissionLookupError
    │
    ├─► [sanitise] strip + lowercase both inputs
    │
    ├─► [repository] get_mission(language, error_code)
    │       │
    │       ├── HIT  → build MissionLookupResult(status=FOUND, mission=...)
    │       │
    │       └── MISS → build MissionLookupResult(status=NOT_FOUND, mission=None)
    │
    └─► return MissionLookupResult  (never raises on a miss — caller decides)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from backend.repository import MissionTemplate, get_mission

# ---------------------------------------------------------------------------
# Module-level logger
# ---------------------------------------------------------------------------

# Using a hierarchical name so the log output can be filtered by prefix:
#   logging.getLogger("zero_magic")        — root namespace
#   logging.getLogger("zero_magic.service") — this module only
logger = logging.getLogger("zero_magic.service")


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

class LookupStatus(str, Enum):
    """
    Discriminant that tells the caller *why* the service returned what it did,
    without requiring try/except on the happy path.

    Using ``str`` as a mixin makes the enum JSON-serialisable out of the box,
    which is convenient if the result is ever logged or cached as JSON.
    """

    FOUND = "FOUND"
    """A static mission was found in the repository for the given key."""

    NOT_FOUND = "NOT_FOUND"
    """
    No static match exists. The router should fall back to LLM generation
    (Phase 7 Step 4) or return a 404 to the extension.
    """

    INVALID_INPUT = "INVALID_INPUT"
    """
    The caller supplied blank or structurally invalid input.
    The router should return a 422 Unprocessable Entity.
    """


@dataclass(frozen=True)
class MissionLookupResult:
    """
    Immutable result envelope returned by ``lookup_mission()``.

    The caller inspects ``status`` to decide what to do next; it never needs
    to catch an exception for a normal miss.

    Attributes:
        status:         One of the ``LookupStatus`` enum values.
        mission:        The matched ``MissionTemplate``, or ``None``.
        language:       The sanitised (lowercased, stripped) language string.
        error_code:     The sanitised (lowercased, stripped) error code string.
        detail:         Human-readable explanation of the outcome — useful for
                        logging and for the router's error response body.
    """

    status: LookupStatus
    mission: Optional[MissionTemplate]
    language: str
    error_code: str
    detail: str

    @property
    def found(self) -> bool:
        """Convenience predicate — ``True`` only when a mission was matched."""
        return self.status is LookupStatus.FOUND


# ---------------------------------------------------------------------------
# Exception
# ---------------------------------------------------------------------------

class MissionLookupError(ValueError):
    """
    Raised by ``lookup_mission()`` when the input is structurally invalid
    (e.g. blank language or error_code strings).

    The router should catch this and respond with HTTP 422.
    A plain miss (no matching mission) does NOT raise — it returns a
    ``MissionLookupResult`` with ``status=NOT_FOUND`` so the caller can
    decide whether to fall back to LLM generation.
    """


# ---------------------------------------------------------------------------
# Public service function
# ---------------------------------------------------------------------------

def lookup_mission(language: str, error_code: str) -> MissionLookupResult:
    """
    Core service function: look up a Socratic mission for a given error.

    This function is the single entry point for mission resolution. It
    validates input, delegates to the repository, and returns a fully
    described ``MissionLookupResult`` regardless of whether a match was found.

    Args:
        language:   Language identifier from VS Code (e.g. ``'python'``,
                    ``'JavaScript'``). Matched case-insensitively.
        error_code: Error type from the compiler / linter (e.g. ``'NameError'``,
                    ``'TYPEERROR'``). Matched case-insensitively.

    Returns:
        A ``MissionLookupResult`` with ``status=FOUND`` and a populated
        ``mission`` field on success, or ``status=NOT_FOUND`` on a miss.

    Raises:
        MissionLookupError: If ``language`` or ``error_code`` is blank /
                            whitespace-only after stripping.

    Example::

        result = lookup_mission("python", "NameError")
        if result.found:
            print(result.mission.title)
        else:
            # Fall back to LLM generation
            ...
    """
    logger.debug(
        "lookup_mission called | raw language=%r  raw error_code=%r",
        language,
        error_code,
    )

    # ------------------------------------------------------------------
    # Step 1 — Input validation
    # ------------------------------------------------------------------
    _validate(language=language, error_code=error_code)

    # ------------------------------------------------------------------
    # Step 2 — Sanitise (strip whitespace + lowercase for consistent keys)
    # ------------------------------------------------------------------
    clean_language = language.strip().lower()
    clean_error_code = error_code.strip().lower()

    logger.info(
        "Mission lookup | language=%r  error_code=%r",
        clean_language,
        clean_error_code,
    )

    # ------------------------------------------------------------------
    # Step 3 — Repository query
    # ------------------------------------------------------------------
    mission = get_mission(language=clean_language, error_code=clean_error_code)

    # ------------------------------------------------------------------
    # Step 4 — Build and return result
    # ------------------------------------------------------------------
    if mission is not None:
        detail = (
            f"Static mission matched: id={mission.mission_id!r}  "
            f"title={mission.title!r}"
        )
        logger.info(
            "HIT | %s | language=%r  error_code=%r",
            mission.mission_id,
            clean_language,
            clean_error_code,
        )
        return MissionLookupResult(
            status=LookupStatus.FOUND,
            mission=mission,
            language=clean_language,
            error_code=clean_error_code,
            detail=detail,
        )

    # Miss path — NOT a bug, just means LLM generation is needed next
    detail = (
        f"No static mission for language={clean_language!r}  "
        f"error_code={clean_error_code!r}. "
        "Caller should fall back to LLM generation."
    )
    logger.warning(
        "MISS | language=%r  error_code=%r — no static mission found",
        clean_language,
        clean_error_code,
    )
    return MissionLookupResult(
        status=LookupStatus.NOT_FOUND,
        mission=None,
        language=clean_language,
        error_code=clean_error_code,
        detail=detail,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _validate(language: str, error_code: str) -> None:
    """
    Validate that both inputs are non-blank strings.

    Raises:
        MissionLookupError: On the first invalid field found.
    """
    if not isinstance(language, str) or not language.strip():
        logger.error(
            "Validation failed: language=%r is blank or not a string", language
        )
        raise MissionLookupError(
            f"'language' must be a non-empty string; got {language!r}"
        )

    if not isinstance(error_code, str) or not error_code.strip():
        logger.error(
            "Validation failed: error_code=%r is blank or not a string", error_code
        )
        raise MissionLookupError(
            f"'error_code' must be a non-empty string; got {error_code!r}"
        )

    logger.debug(
        "Validation passed | language=%r  error_code=%r", language, error_code
    )
