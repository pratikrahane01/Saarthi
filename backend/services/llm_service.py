"""
llm_service.py — Optional LLM enrichment layer for Zero-Magic missions.

Responsibility
--------------
Given the exact error context a student hit (language, error code, raw message),
call an LLM to produce ONE additional contextual Socratic question and ONE
additional contextual hint that are specific to *this* error — not the generic
ones already stored in the mission repository.

Design contract
---------------
1. The mission repository is ALWAYS the primary source of truth.
   LLM output only *appends* to what is already there — it never replaces.

2. This service is entirely optional.
   If the OpenAI API key is absent, the network is unreachable, the API
   returns an error, or the response cannot be parsed, the service returns
   ``None`` and logs a warning. The caller continues with repository content
   only. The student experience degrades gracefully rather than breaking.

3. The LLM is given a strict system prompt that enforces three hard rules:
   - NEVER write code of any kind.
   - NEVER reveal the fix or solution.
   - ONLY produce educational guidance that makes the student think.

4. A short timeout (default 6 s) prevents a slow API call from stalling the
   HTTP response. The caller is not blocked on LLM availability.

Environment variable
--------------------
``OPENAI_API_KEY`` — must be set for LLM calls to be attempted.
If absent the service skips the call and returns ``None`` immediately.

Optionality of the openai package
----------------------------------
``openai`` is an optional dependency listed in requirements.txt.
If it is not installed the module still imports cleanly and every call returns
``None`` (safe-skip mode). This lets the team ship without the dependency
during the hackathon if they prefer.

Extending
---------
To swap the LLM provider (e.g. Anthropic, Gemini), replace ``_call_openai``
with a new function that satisfies the same signature and update ``enrich_mission``
to call it. No other file needs to change.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("zero_magic.llm")

# ---------------------------------------------------------------------------
# Optional import — openai is not hard-required
# ---------------------------------------------------------------------------

try:
    import openai as _openai_module  # type: ignore[import]
    _OPENAI_AVAILABLE = True
except ImportError:
    _openai_module = None  # type: ignore[assignment]
    _OPENAI_AVAILABLE = False
    logger.warning(
        "openai package not installed — LLM enrichment will be skipped. "
        "Install with: pip install openai"
    )


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LLMEnrichment:
    """
    A single contextual question + hint produced by the LLM for a specific
    student error. Both fields are guaranteed non-empty when present.

    Attributes:
        contextual_question: A Socratic question tailored to the exact error
                             message, not the generic concept category.
        contextual_hint:     A progressive hint more specific than the
                             repository hints — still no code, no solution.
        source:              Internal label: ``'llm'`` when produced by the API,
                             ``'skipped'`` when the API key is absent,
                             ``'fallback'`` when parsing failed but a safe
                             fallback was used. Never sent to the client.
    """

    contextual_question: str
    contextual_hint: str
    source: str = "llm"


# ---------------------------------------------------------------------------
# System prompt — the hard guardrails fed to the LLM
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are a Socratic programming educator embedded in a learning tool.
A student has just hit a compiler or runtime error and needs help thinking
through it — NOT being given the answer.

YOUR ABSOLUTE RULES:
1. NEVER write any code, variable names, syntax, function calls, or snippets.
2. NEVER reveal the fix, the solution, or the corrected line.
3. NEVER tell the student exactly what to do.
4. ONLY ask questions that guide the student to discover the problem themselves.
5. ONLY give hints that point toward a concept or a place to look — never toward
   a specific code change.
6. Use plain English only. No technical jargon the student has not already used.

OUTPUT FORMAT — respond with ONLY this JSON object and nothing else:
{
  "contextualQuestion": "<one question specific to the exact error message>",
  "contextualHint": "<one hint that narrows the student's search>"
}

If you cannot produce safe educational output, respond with:
{"contextualQuestion": null, "contextualHint": null}
"""

_DEFAULT_TIMEOUT_SECONDS: float = 6.0
_MODEL = "gpt-4o-mini"   # fast, cheap, sufficient for short educational prompts


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def enrich_mission(
    language: str,
    error_code: str,
    message: str,
    timeout: float = _DEFAULT_TIMEOUT_SECONDS,
) -> Optional[LLMEnrichment]:
    """
    Attempt to enrich a mission with one contextual question and one contextual
    hint that are specific to the student's exact error message.

    This function NEVER raises. Every failure path returns ``None`` so the
    caller can treat enrichment as a best-effort bonus.

    Args:
        language:   VS Code languageId (e.g. ``'python'``, ``'javascript'``).
        error_code: Error type string (e.g. ``'NameError'``).
        message:    Full raw error message from the compiler/linter.
        timeout:    Max seconds to wait for the LLM API response.

    Returns:
        ``LLMEnrichment`` on success, ``None`` on any failure or skip.
    """
    # ── Pre-flight checks ────────────────────────────────────────────────────
    if not _OPENAI_AVAILABLE:
        logger.debug("LLM enrichment skipped: openai package not installed.")
        return None

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        logger.debug(
            "LLM enrichment skipped: OPENAI_API_KEY not set in environment."
        )
        return None

    if not message.strip():
        logger.debug(
            "LLM enrichment skipped: empty error message — "
            "no context to be specific about."
        )
        return None

    # ── Build user prompt ─────────────────────────────────────────────────────
    user_prompt = _build_user_prompt(
        language=language,
        error_code=error_code,
        message=message,
    )

    logger.info(
        "LLM enrichment requested | language=%r  error_code=%r  message=%r",
        language,
        error_code,
        message[:60] + "…" if len(message) > 60 else message,
    )

    # ── Call the LLM ──────────────────────────────────────────────────────────
    raw_response = _call_openai(
        api_key=api_key,
        user_prompt=user_prompt,
        timeout=timeout,
    )

    if raw_response is None:
        # _call_openai already logged the failure
        return None

    # ── Parse response ────────────────────────────────────────────────────────
    return _parse_response(raw_response)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_user_prompt(language: str, error_code: str, message: str) -> str:
    """
    Construct the user-turn message sent to the LLM.

    Keeping this isolated makes it trivial to test prompt construction
    independently of the API call.
    """
    return (
        f"A student is working in {language} and just encountered this error:\n\n"
        f"Error type: {error_code}\n"
        f"Error message: {message}\n\n"
        "Generate:\n"
        "1. One Socratic question that is SPECIFIC to this exact error message "
        "(not just the general error type).\n"
        "2. One progressive hint that makes the student look in the right "
        "direction without telling them what to change.\n\n"
        "Remember: no code, no solutions, plain English only.\n"
        "Respond with the JSON object described in your instructions."
    )


def _call_openai(
    api_key: str,
    user_prompt: str,
    timeout: float,
) -> Optional[str]:
    """
    Make the OpenAI chat completion call.

    Returns the raw content string from the first choice, or ``None`` on
    any error (network, auth, rate-limit, timeout, unexpected exception).
    All errors are caught and logged — this function never raises.
    """
    try:
        client = _openai_module.OpenAI(api_key=api_key, timeout=timeout)
        response = client.chat.completions.create(
            model=_MODEL,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt},
            ],
            temperature=0.4,     # low randomness → consistent Socratic style
            max_tokens=256,      # question + hint comfortably fit in 256 tokens
            response_format={"type": "json_object"},  # enforce JSON output
        )
        content = response.choices[0].message.content
        logger.debug("LLM raw response: %r", content[:200] if content else None)
        return content

    except _openai_module.AuthenticationError:
        logger.warning(
            "LLM enrichment skipped: OPENAI_API_KEY is invalid or expired."
        )
    except _openai_module.RateLimitError:
        logger.warning(
            "LLM enrichment skipped: OpenAI rate limit hit — "
            "mission will use repository content only."
        )
    except _openai_module.APITimeoutError:
        logger.warning(
            "LLM enrichment skipped: API call timed out after %.1fs.", timeout
        )
    except _openai_module.APIConnectionError as exc:
        logger.warning(
            "LLM enrichment skipped: network error — %s", exc
        )
    except _openai_module.APIStatusError as exc:
        logger.warning(
            "LLM enrichment skipped: API returned status %d — %s",
            exc.status_code, exc.message,
        )
    except Exception as exc:  # noqa: BLE001 — catch-all intentional
        logger.error(
            "LLM enrichment failed with unexpected error: %s: %s",
            type(exc).__name__, exc,
        )

    return None


def _parse_response(raw: str) -> Optional[LLMEnrichment]:
    """
    Parse the JSON returned by the LLM into an ``LLMEnrichment``.

    Returns ``None`` if:
    - The JSON cannot be decoded.
    - Either required key is missing or null.
    - Either value is an empty string after stripping.
    - The response contains code-like content (basic safety check).

    Returns a fallback ``LLMEnrichment`` (source='fallback') if the JSON
    structure is valid but the content is low-quality so the caller still
    gets *something* useful.
    """
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("LLM response was not valid JSON: %s | raw=%r", exc, raw[:100])
        return None

    question = (data.get("contextualQuestion") or "").strip()
    hint     = (data.get("contextualHint")     or "").strip()

    # LLM indicated it could not produce safe output
    if not question or not hint:
        logger.warning(
            "LLM returned null/empty fields — enrichment skipped. data=%r", data
        )
        return None

    # Basic safety check: reject if response looks like it contains code.
    # Heuristic: lines starting with common code patterns.
    combined = question + " " + hint
    if _looks_like_code(combined):
        logger.warning(
            "LLM response appears to contain code — enrichment rejected for safety."
        )
        return None

    logger.info(
        "LLM enrichment parsed successfully | "
        "question_len=%d  hint_len=%d",
        len(question), len(hint),
    )
    return LLMEnrichment(
        contextual_question=question,
        contextual_hint=hint,
        source="llm",
    )


def _looks_like_code(text: str) -> bool:
    """
    Heuristic safety gate: return True if the text appears to contain
    code fragments that violate the "no code" rule.

    Checks for common code indicators: assignment operators, function
    call patterns, ``def``/``let``/``var`` keywords at line start, etc.
    This is intentionally conservative — a false positive is safer than
    a false negative.
    """
    import re

    code_patterns = [
        r"^\s*(def|class|let|const|var|function|import|from)\s+\w",  # declarations
        r"=\s*[\w\"'\[\{]",                                           # assignment
        r"\w+\s*\(",                                                   # function call
        r"```",                                                        # code fence
        r"^\s*#\s*\w",                                                 # code comment
        r"^\s*//",                                                     # JS comment
        r"print\s*\(",                                                 # print call
        r"console\.\w+\s*\(",                                          # console.*()
    ]
    for pattern in code_patterns:
        if re.search(pattern, text, re.MULTILINE | re.IGNORECASE):
            logger.debug("Code pattern detected: %r", pattern)
            return True
    return False
