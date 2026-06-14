"""
context_service.py — Priority-based context resolution for Zero-Magic.

Implements the canonical priority rule:
    terminalOutput > diagnosticMessage > errorCode

This service is the single source of truth for deciding which piece of
context the Groq prompt should be built around. The router calls
``resolve_primary_context()`` before delegating to groq_service so that
the LLM always receives the richest available signal.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger("zero_magic.service.context")


# ---------------------------------------------------------------------------
# Context priority enum
# ---------------------------------------------------------------------------

class ContextSource(str, Enum):
    """Tracks which input field won the priority election."""
    TERMINAL_OUTPUT   = "terminal_output"
    DIAGNOSTIC_MESSAGE = "diagnostic_message"
    ERROR_CODE        = "error_code"


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ResolvedContext:
    """
    The result of context resolution.

    Attributes:
        source:         Which input field was chosen as primary context.
        primary_text:   The winning text, ready to be injected into a prompt.
        has_terminal:   True when real terminal output is present.
        has_source_code: True when source code was provided.
    """
    source: ContextSource
    primary_text: str
    has_terminal: bool
    has_source_code: bool


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def resolve_primary_context(
    *,
    error_code: str,
    message: str,
    diagnostic_message: str = "",
    terminal_output: str = "",
    source_code: str = "",
) -> ResolvedContext:
    """
    Apply the priority rule and return a ``ResolvedContext``.

    Priority (highest → lowest):
      1. ``terminal_output``     — actual runtime output (stdout + stderr)
      2. ``diagnostic_message``  — IDE language-server diagnostic text
      3. ``message``             — raw error message from the watcher
      4. ``error_code``          — bare error type identifier (last resort)

    All string inputs are stripped before comparison so that blank-space-only
    values are treated as absent.

    Args:
        error_code:          Short error type (e.g. 'NameError').
        message:             Full error message from the VS Code watcher.
        diagnostic_message:  Explicit diagnostic text from ContextBuilder.
        terminal_output:     Combined stdout+stderr from last terminal run.
        source_code:         Active file source code (informational only).

    Returns:
        A ``ResolvedContext`` with the winning text and metadata flags.
    """
    terminal_clean = terminal_output.strip()
    diag_clean     = diagnostic_message.strip()
    msg_clean      = message.strip()
    code_clean     = error_code.strip()

    has_terminal    = bool(terminal_clean)
    has_source_code = bool(source_code.strip())

    if has_terminal:
        logger.info(
            "Context resolution: TERMINAL_OUTPUT wins "
            "(%d chars of terminal output present)",
            len(terminal_clean),
        )
        return ResolvedContext(
            source=ContextSource.TERMINAL_OUTPUT,
            primary_text=terminal_clean,
            has_terminal=True,
            has_source_code=has_source_code,
        )

    if diag_clean:
        logger.info(
            "Context resolution: DIAGNOSTIC_MESSAGE wins "
            "(terminal output absent, diagnostic=%r…)",
            diag_clean[:60],
        )
        return ResolvedContext(
            source=ContextSource.DIAGNOSTIC_MESSAGE,
            primary_text=diag_clean,
            has_terminal=False,
            has_source_code=has_source_code,
        )

    # Prefer full message over bare error code
    primary = msg_clean or code_clean
    source  = ContextSource.ERROR_CODE

    logger.info(
        "Context resolution: ERROR_CODE/MESSAGE fallback "
        "(no terminal, no diagnostic) → %r…",
        primary[:60],
    )
    return ResolvedContext(
        source=source,
        primary_text=primary,
        has_terminal=False,
        has_source_code=has_source_code,
    )


def build_groq_context_block(
    *,
    language: str,
    error_code: str,
    resolved: ResolvedContext,
    source_code: str = "",
    exit_code: int = -1,
) -> str:
    """
    Assemble the user-prompt section that is injected into the Groq request.

    When terminal output is present the block explicitly labels it as
    ``[RUNTIME ERROR]`` and includes the exit code, producing prompts like:

        Language: python
        Error Code: NameError
        Context Source: terminal_output

        [RUNTIME ERROR — Exit Code: 1]
        Traceback (most recent call last):
          File "app.py", line 5, in <module>
            print(result)
        NameError: name 'result' is not defined

        [SOURCE CODE]
        def compute():
            x = 42
        print(result)

    When no terminal output is available the block degrades gracefully to the
    original message-only format.

    Args:
        language:    Programming language identifier.
        error_code:  Short error type string.
        resolved:    Output of ``resolve_primary_context()``.
        source_code: Active file source (appended when non-empty).
        exit_code:   Last process exit code (-1 = never ran).

    Returns:
        A multi-line string ready to be used as the Groq user prompt.
    """
    lines: list[str] = [
        f"Language: {language}",
        f"Error Code: {error_code}",
        f"Context Source: {resolved.source.value}",
        "",
    ]

    if resolved.source == ContextSource.TERMINAL_OUTPUT:
        exit_label = f"Exit Code: {exit_code}" if exit_code != -1 else "Exit Code: unknown"
        lines += [
            f"[RUNTIME ERROR — {exit_label}]",
            resolved.primary_text,
            "",
        ]
    else:
        lines += [
            "[ERROR CONTEXT]",
            resolved.primary_text,
            "",
        ]

    if source_code.strip():
        lines += [
            "[SOURCE CODE]",
            source_code.strip(),
            "",
        ]

    lines.append(
        "Generate a highly specific Socratic mission targeting this exact "
        "error. Ask questions about the student's specific code — never give "
        "generic advice. Do NOT reveal the fix."
    )

    return "\n".join(lines)
