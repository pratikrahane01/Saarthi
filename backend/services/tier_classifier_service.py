"""
tier_classifier_service.py — Groq-powered error tier classifier for Zero-Magic.

Uses GROQ_API_KEY1 (a dedicated second key) to analyse incoming error context
and classify it into one of three tiers:

    Tier 1 — Syntax / Import / Typo  (lightweight nudge, no Deep Dive)
    Tier 2 — Logic / Type / Async    (analysis card + opt-in Deep Dive)
    Tier 3 — Runtime / Traceback     (auto-trigger Deep Dive)

A fast regex pre-filter runs BEFORE the LLM call so that obvious Tier 1
errors (missing bracket, import failure) are classified in < 1 ms without
any network latency.

Public API
----------
    result = classify_error_tier(
        language="python",
        error_code="TypeError",
        message="...",
        terminal_output="...",
        source_code="...",
        line_number=14,
    )
    # result.tier        → 1 | 2 | 3
    # result.pro_tip     → str (Tier 1 only)
    # result.explanation → str (Tier 2/3 — one-sentence rationale)
    # result.source      → "regex" | "llm" | "fallback"
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Literal

logger = logging.getLogger("zero_magic.service.tier_classifier")

# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------

ErrorTier = Literal[1, 2, 3]


@dataclass(frozen=True)
class TierClassification:
    """
    Result of error tier classification.

    Attributes:
        tier:        1 = syntax nudge, 2 = analysis card, 3 = deep dive
        error_flag:  Human-readable one-liner: "Line N: ErrorCode: message"
        pro_tip:     Tier 1 only — curated tip shown without API call
        explanation: Tier 2/3 — LLM rationale for why this tier was chosen
        source:      'regex' | 'llm' | 'fallback' — how the tier was decided
    """
    tier: ErrorTier
    error_flag: str
    pro_tip: str = ""
    explanation: str = ""
    source: Literal["regex", "llm", "fallback"] = "fallback"
    api_used: str = "none"


# ---------------------------------------------------------------------------
# Static Tier-1 Pro-Tip library (curated, zero-latency)
# ---------------------------------------------------------------------------

_TIER1_TIPS: dict[str, str] = {
    "SyntaxError":          "Tip: Read the caret (^) in the traceback — it points to the exact character the parser rejected.",
    "IndentationError":     "Tip: Python is whitespace-sensitive. Mix of tabs and spaces causes this — pick one and be consistent.",
    "TabError":             "Tip: Convert all tabs to 4 spaces. Use your editor's 'Show Whitespace' mode to spot invisible tabs.",
    "ParseError":           "Tip: Parsing failed before the code ran. Check the line before the reported one — the real culprit is often there.",
    "ModuleNotFoundError":  "Tip: Activate your virtual environment first: `source venv/bin/activate` (Linux/Mac) or `venv\\Scripts\\activate` (Windows).",
    "ImportError":          "Tip: Verify the package is installed in the same Python that runs the file. Run `pip list` to confirm.",
    "Cannot find module":   "Tip: Run `npm install` to restore missing node_modules, then check your tsconfig `paths` aliases.",
    "unexpected token":     "Tip: When nesting async calls, keep closure scopes explicit — arrow functions inside `.then()` chains need their own `return`.",
    "missing )":            "Tip: Count open vs. closing parentheses from the innermost call outward. A missing `)` is usually one level up from where the error fires.",
    "missing }":            "Tip: Use your editor's bracket-matching (Ctrl+Shift+\\) to jump to the unmatched brace.",
    "missing ]":            "Tip: List comprehensions and slice expressions must close before the next statement begins.",
    "EOL while scanning":   "Tip: A string literal is missing its closing quote. Check for a stray `'` or `\"` on the reported line.",
    "EOF while parsing":    "Tip: The file ended before all blocks were closed. Scroll to the bottom — you are likely missing a closing bracket or parenthesis.",
    "expected an indented block": "Tip: Every `if`, `for`, `def`, or `class` block needs at least one indented statement. Use `pass` as a placeholder.",
    "Expected ':'":         "Tip: Python requires a colon (:) at the end of if, for, while, def, and class statements.",
    "Expected expression":  "Tip: An expression was expected here. Check for trailing operators, missing values, or unclosed brackets before this line.",
    "invalid syntax":       "Tip: The parser couldn't make sense of this line. Check for missing punctuation, unmatched brackets, or typos just before this point.",
    "statement expected":   "Tip: A valid statement was expected. Check for incomplete lines or missing keywords.",
}

_TIER1_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"SyntaxError",        re.I), "SyntaxError"),
    (re.compile(r"IndentationError",   re.I), "IndentationError"),
    (re.compile(r"TabError",           re.I), "TabError"),
    (re.compile(r"ParseError",         re.I), "ParseError"),
    (re.compile(r"ModuleNotFoundError",re.I), "ModuleNotFoundError"),
    (re.compile(r"ImportError",        re.I), "ImportError"),
    (re.compile(r"Cannot find module", re.I), "Cannot find module"),
    (re.compile(r"unexpected token",   re.I), "unexpected token"),
    (re.compile(r"missing \)",         re.I), "missing )"),
    (re.compile(r"missing \}",         re.I), "missing }"),
    (re.compile(r"missing \]",         re.I), "missing ]"),
    (re.compile(r"EOL while scanning", re.I), "EOL while scanning"),
    (re.compile(r"EOF while parsing",  re.I), "EOF while parsing"),
    (re.compile(r"expected an indented block", re.I), "expected an indented block"),
    (re.compile(r"Expected ':'",       re.I), "Expected ':'"),
    (re.compile(r"Expected expression",re.I), "Expected expression"),
    (re.compile(r"invalid syntax",     re.I), "invalid syntax"),
    (re.compile(r"statement expected", re.I), "statement expected"),
]

# Tier 3 fast-path: deep runtime signals that skip straight to Deep Dive
_TIER3_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"RecursionError",         re.I),
    re.compile(r"MemoryError",            re.I),
    re.compile(r"SegmentationFault",      re.I),
    re.compile(r"SystemExit",             re.I),
    re.compile(r"KeyboardInterrupt",      re.I),
    re.compile(r"Traceback \(most recent call last\)", re.I),
    re.compile(r"AssertionError.*test",   re.I),
]


def _build_error_flag(error_code: str, message: str, line_number: int) -> str:
    """Format: 'Line N: ErrorCode: short message'"""
    short = message[:120].strip().replace("\n", " ")
    if line_number > 0:
        return f"Line {line_number}: {error_code}: {short}"
    return f"{error_code}: {short}"


# ---------------------------------------------------------------------------
# Regex fast-path
# ---------------------------------------------------------------------------

def _try_regex_classify(
    error_code: str,
    message: str,
    terminal_output: str,
    line_number: int,
) -> TierClassification | None:
    """
    Attempt Tier 1 or Tier 3 classification using pure regex.

    Returns a TierClassification if a confident match is found, else None
    (caller should fall through to the LLM).
    """
    combined = f"{error_code} {message}"
    flag = _build_error_flag(error_code, message, line_number)

    # ── Tier 1 fast-path ──────────────────────────────────────────────────
    for pattern, key in _TIER1_PATTERNS:
        if pattern.search(combined):
            tip = _TIER1_TIPS.get(key, "Tip: Read the full error message — it usually names the exact element causing the problem.")
            logger.debug("Regex → Tier 1 via pattern %r", key)
            return TierClassification(
                tier=1,
                error_flag=flag,
                pro_tip=tip,
                explanation="",
                source="regex",
                api_used="none",
            )

    # ── Tier 3 fast-path (terminal traceback or explicit runtime signals) ─
    terminal_newlines = terminal_output.count("\n")
    for pattern in _TIER3_PATTERNS:
        if pattern.search(combined) or pattern.search(terminal_output):
            logger.debug("Regex → Tier 3 via pattern %r", pattern.pattern)
            return TierClassification(
                tier=3,
                error_flag=flag,
                pro_tip="",
                explanation="Runtime crash detected — isolating root cause for Deep Dive.",
                source="regex",
                api_used="none",
            )

    # Long multi-line terminal traceback → Tier 3
    if terminal_newlines > 5 and terminal_output.strip():
        logger.debug("Regex → Tier 3 via long terminal traceback (%d lines)", terminal_newlines)
        return TierClassification(
            tier=3,
            error_flag=flag,
            pro_tip="",
            explanation=f"Multi-line runtime traceback detected ({terminal_newlines} lines). Isolating root cause.",
            source="regex",
            api_used="none",
        )

    return None  # Let the LLM decide


# ---------------------------------------------------------------------------
# LLM classifier (GROQ_API_KEY1)
# ---------------------------------------------------------------------------

_CLASSIFIER_SYSTEM_PROMPT = """\
You are an expert programming-error triage system for a Socratic learning tool.

Your job: analyse the given error context and classify it into exactly ONE tier.

TIER DEFINITIONS:
  Tier 1 — Syntax / Import / Typo
    Triggered by: SyntaxError, IndentationError, TabError, ParseError,
    ModuleNotFoundError, ImportError, missing brackets/quotes/colons,
    unexpected token, EOF/EOL errors.
    Characteristics: The file did not execute at all. No runtime output.
    Fix is always local (one character or one import statement).

  Tier 2 — Logic / Type / Async (opt-in Deep Dive)
    Triggered by: TypeError, AttributeError, KeyError, IndexError,
    NameError (variable not defined at runtime), ValueError,
    UnboundLocalError, Promise/async resolution errors, "cannot read
    properties of undefined", incorrect return types.
    Characteristics: Code executed partially. Error is semantic, not syntactic.
    Fix requires understanding data flow or variable scope.

  Tier 3 — Runtime / Structural (auto Deep Dive)
    Triggered by: RecursionError, MemoryError, RuntimeError, multi-line
    tracebacks with 3+ frames, AssertionError from test runners,
    infinite loops (exit code -1 or timeout), SegFault, SystemExit.
    Characteristics: Code executed significantly before crashing.
    Fix requires understanding architecture or algorithm structure.

RULES:
  1. Return JSON only — no markdown, no explanation outside the JSON.
  2. "tier" must be the integer 1, 2, or 3.
  3. "explanation" must be ONE sentence (≤ 20 words) explaining WHY this tier.
  4. "pro_tip" is only populated for Tier 1; leave empty string for Tier 2/3.
  5. IGNORE all commented out lines of code (such as those starting with #, //, or enclosed in ''' or \"\"\").

REQUIRED JSON FORMAT:
{
  "tier": 2,
  "explanation": "TypeError at runtime indicates a semantic mismatch in data types, not a syntax issue.",
  "pro_tip": ""
}
"""


def _call_groq_classifier(
    language: str,
    error_code: str,
    message: str,
    terminal_output: str,
    source_code: str,
    line_number: int,
) -> TierClassification | None:
    """
    Call GROQ_API_KEY1 to classify the error tier via LLM.

    Returns None on any failure so the caller can use the fallback.
    """
    try:
        from groq import Groq, APIError
    except ImportError:
        logger.warning("groq package not installed — skipping LLM tier classification")
        return None

    api_key = os.environ.get("GROQ_API_KEY1")
    if not api_key:
        logger.warning("GROQ_API_KEY1 not set — skipping LLM tier classification")
        return None

    flag = _build_error_flag(error_code, message, line_number)

    # Build a concise user prompt — keep tokens low for fast response
    terminal_snippet = terminal_output.strip()[:800] if terminal_output else "(none)"
    source_snippet   = source_code.strip()[:600]    if source_code   else "(none)"

    user_prompt = (
        f"Language: {language}\n"
        f"Error Code: {error_code}\n"
        f"Error Message: {message[:300]}\n"
        f"Line Number: {line_number if line_number > 0 else 'unknown'}\n"
        f"Terminal Output:\n{terminal_snippet}\n"
        f"Source Code Snippet:\n{source_snippet}\n"
        "\nClassify this error into Tier 1, 2, or 3 and return JSON."
    )

    try:
        client = Groq(api_key=api_key)
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": _CLASSIFIER_SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.1,   # low temp — we want deterministic classification
            max_tokens=120,    # small response: just tier + explanation + pro_tip
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("Empty response from Groq classifier")

        data = json.loads(content)

        raw_tier = int(data.get("tier", 2))
        if raw_tier not in (1, 2, 3):
            raise ValueError(f"Invalid tier value from LLM: {raw_tier}")

        tier: ErrorTier = raw_tier  # type: ignore[assignment]
        explanation = str(data.get("explanation", "")).strip()
        pro_tip     = str(data.get("pro_tip",     "")).strip()

        # If LLM says Tier 1 but gave no pro_tip, look it up in our static library
        if tier == 1 and not pro_tip:
            for _pattern, key in _TIER1_PATTERNS:
                if _pattern.search(f"{error_code} {message}"):
                    pro_tip = _TIER1_TIPS.get(key, "")
                    break

        logger.info(
            "LLM tier classification: tier=%d  explanation=%r  source=llm",
            tier, explanation[:60],
        )

        return TierClassification(
            tier=tier,
            error_flag=flag,
            pro_tip=pro_tip,
            explanation=explanation,
            source="llm",
            api_used="groq",
        )

    except (json.JSONDecodeError, ValueError, KeyError) as exc:
        logger.error("Groq tier classifier — bad JSON response: %s", exc)
        return None
    except Exception as exc:  # APIError, network, etc.
        logger.error("Groq tier classifier — unexpected error: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def classify_error_tier(
    *,
    language: str,
    error_code: str,
    message: str,
    terminal_output: str = "",
    source_code: str = "",
    line_number: int = 0,
) -> TierClassification:
    """
    Classify an error into Tier 1 / 2 / 3.

    Decision order:
      1. Regex fast-path  — instant, no network (Tier 1 syntax + Tier 3 traceback)
      2. LLM (GROQ_API_KEY1) — semantic classification for ambiguous cases
      3. Fallback → Tier 2  — safe default that always shows the analysis card

    Args:
        language:        Programming language ('python', 'javascript', etc.)
        error_code:      Short error type ('TypeError', 'SyntaxError', …)
        message:         Full error message string from IDE / terminal
        terminal_output: Combined stdout + stderr from the last terminal run
        source_code:     Active file source code (optional, improves LLM accuracy)
        line_number:     Line number where the error occurred (0 = unknown)

    Returns:
        A TierClassification with tier, error_flag, pro_tip, explanation, source.
    """
    logger.debug(
        "classify_error_tier | lang=%s  code=%s  line=%d  terminal_len=%d",
        language, error_code, line_number, len(terminal_output),
    )

    # ── 1. Regex fast-path ────────────────────────────────────────────────
    regex_result = _try_regex_classify(error_code, message, terminal_output, line_number)
    if regex_result is not None:
        return regex_result

    # ── 2. LLM classification via GROQ_API_KEY1 ───────────────────────────
    llm_result = _call_groq_classifier(
        language=language,
        error_code=error_code,
        message=message,
        terminal_output=terminal_output,
        source_code=source_code,
        line_number=line_number,
    )
    if llm_result is not None:
        return llm_result

    # ── 3. Safe fallback → Tier 2 (always shows the analysis card) ───────
    flag = _build_error_flag(error_code, message, line_number)
    logger.info("classify_error_tier → Tier 2 fallback (regex+LLM both inconclusive)")
    return TierClassification(
        tier=2,
        error_flag=flag,
        pro_tip="",
        explanation="Could not classify error precisely — defaulting to guided analysis.",
        source="fallback",
        api_used="none",
    )
