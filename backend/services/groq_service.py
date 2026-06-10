"""
groq_service.py — Dynamic mission generation using the Groq API.

Provides fallback generation when the static mission repository has no match
for a given language and error code.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

try:
    from groq import Groq
    from groq import APIError
except ImportError:
    Groq = None
    APIError = Exception

logger = logging.getLogger("zero_magic.service.groq")


@dataclass(frozen=True)
class DynamicMissionResult:
    """Structure returned by the Groq service for dynamic missions."""
    concept: str
    questions: list[str]
    hints: list[str]


# ---------------------------------------------------------------------------
# Fallback / Generic Mission
# ---------------------------------------------------------------------------

def _build_generic_mission(language: str, error_code: str) -> DynamicMissionResult:
    """
    Constructs a generic, safe fallback mission if the Groq API call fails
    or the environment is misconfigured.
    """
    logger.info("Building generic fallback mission for %s (%s)", language, error_code)
    return DynamicMissionResult(
        concept=(
            "An unexpected error occurred. Error codes are your compiler's way of "
            "telling you that it doesn't understand your code or that an illegal "
            "operation was attempted."
        ),
        questions=[
            "What does the error message explicitly say?",
            "Which line of code is the compiler complaining about?",
        ],
        hints=[
            "Read the error message carefully. It usually names the missing or invalid element.",
            "Look at the exact line number mentioned and ensure all variables and syntax are correct.",
            "Use standard debugging techniques: check variable state and documentation.",
        ]
    )


# ---------------------------------------------------------------------------
# Public Service Function
# ---------------------------------------------------------------------------

def generate_dynamic_mission(
    language: str,
    error_code: str,
    message: str,
    source_code: str = "",
    terminal_output: str = "",
    exit_code: int = -1,
) -> DynamicMissionResult:
    """
    Call the Groq API to dynamically generate a Socratic mission based on the
    diagnostic information and runtime terminal context.

    Context priority (matches context_service.py):
        terminal_output > message/diagnostic_message > error_code

    When terminal_output is present, the prompt is built around the actual
    runtime output and source code so the generated Socratic questions are
    highly specific — never generic error explanations.

    Enforces strict JSON output containing:
    - concept
    - question
    - hintLevel1
    - hintLevel2
    - hintLevel3

    Rules enforced via system prompt:
    - Socratic teaching style
    - NO code
    - NO direct fixes
    - Questions must reference the student's actual code/output when available

    Returns:
        A DynamicMissionResult. If any error occurs (API key missing, network
        failure, bad JSON), it gracefully returns a generic fallback mission.
    """
    from backend.services.context_service import (
        resolve_primary_context,
        build_groq_context_block,
    )

    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key or Groq is None:
        logger.warning("Groq API key not found or groq package missing. Using generic fallback.")
        return _build_generic_mission(language, error_code)

    # Resolve which context source wins
    resolved = resolve_primary_context(
        error_code=error_code,
        message=message,
        terminal_output=terminal_output,
        source_code=source_code,
    )

    client = Groq(api_key=api_key)

    system_prompt = (
        "You are Socrates, an AI debugging mentor for student programmers.\n\n"
        "Rules:\n\n"
        "1. Never provide corrected code.\n"
        "2. Never provide direct fixes.\n"
        "3. Explain the underlying concept in plain English.\n"
        "4. Ask ONE Socratic question that references the student's SPECIFIC code "
        "or runtime output — never ask generic questions.\n"
        "5. Generate 3 progressive hints that guide thinking without revealing the fix.\n"
        "6. When terminal output is provided, your questions and hints MUST reference "
        "specific lines, variable names, or values seen in that output.\n"
        "7. When source code is provided, reference specific line numbers or "
        "identifiers from the code in your question.\n\n"
        "Return JSON only.\n\n"
        "REQUIRED JSON FORMAT:\n"
        "{\n"
        "  \"concept\": \"...\",\n"
        "  \"question\": \"...\",\n"
        "  \"hintLevel1\": \"...\",\n"
        "  \"hintLevel2\": \"...\",\n"
        "  \"hintLevel3\": \"...\"\n"
        "}"
    )

    # Build the user prompt using priority: terminal_output > message > error_code
    terminal_clean = terminal_output.strip()
    source_clean   = source_code.strip()

    if terminal_clean:
        # Highest-priority: actual runtime output + source code
        exit_label = f"Exit Code: {exit_code}" if exit_code != -1 else "Exit Code: unknown"
        user_prompt = (
            f"Language: {language}\n"
            f"Error Type: {error_code}\n\n"
            f"[RUNTIME ERROR — {exit_label}]\n"
            f"{terminal_clean}\n"
        )
        if source_clean:
            user_prompt += (
                f"\n[SOURCE CODE]\n"
                f"{source_clean[:3000]}\n"  # cap at 3k chars to stay in token budget
            )
        user_prompt += (
            "\nUsing the runtime output and source code above, generate a highly "
            "specific Socratic mission. Your question MUST reference specific "
            "variable names, line numbers, or output values seen above. "
            "Do NOT give generic debugging advice. Do NOT reveal the fix."
        )
    else:
        # Fallback: diagnostic message only
        user_prompt = (
            f"Language: {language}\n"
            f"Error Code: {error_code}\n"
            f"Error Message: {message}\n"
        )
        if source_clean:
            user_prompt += (
                f"\n[SOURCE CODE]\n"
                f"{source_clean[:3000]}\n"
            )
        user_prompt += "\nGenerate the Socratic JSON response for this error."

    logger.info(
        "Groq prompt context: context_source=%s  has_terminal=%s  has_code=%s",
        resolved.source.value,
        resolved.has_terminal,
        resolved.has_source_code,
    )

    try:
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",  # Fast default model
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.7,
            max_tokens=500,
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("Empty response from Groq")

        data = json.loads(content)

        # Validate required fields
        required_keys = ["concept", "question", "hintLevel1", "hintLevel2", "hintLevel3"]
        for key in required_keys:
            if key not in data or not isinstance(data[key], str):
                raise ValueError(f"Missing or invalid field in Groq response: {key}")

        return DynamicMissionResult(
            concept=data["concept"],
            questions=[data["question"], "Can you identify exactly where the issue occurs in your code?"],
            hints=[data["hintLevel1"], data["hintLevel2"], data["hintLevel3"]]
        )

    except (APIError, json.JSONDecodeError, ValueError) as exc:
        logger.error("Groq generation failed: %s", exc)
        return _build_generic_mission(language, error_code)
    except Exception as exc:
        logger.error("Unexpected error during Groq generation: %s", exc)
        return _build_generic_mission(language, error_code)



@dataclass(frozen=True)
class SolutionResult:
    fixedCode: str
    explanation: str
    conceptSummary: str

def generate_expert_solution(language: str, error_code: str, source_code: str, message: str) -> SolutionResult:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key or Groq is None:
        logger.warning("Groq API key not found or groq package missing. Using generic fallback.")
        return SolutionResult(
            fixedCode=f"// Fallback fix for {error_code}\n// Unable to connect to backend AI.",
            explanation="The backend could not generate a solution because the AI service is unreachable.",
            conceptSummary="Check your connection or API keys to enable Expert Solutions."
        )

    client = Groq(api_key=api_key)

    system_prompt = (
        "You are an expert software engineer providing a definitive solution to a programming error.\n\n"
        "Rules:\n"
        "1. Provide the corrected source code in full, or the exact snippet required if it's large.\n"
        "2. Explain what was wrong and how you fixed it.\n"
        "3. Provide a brief concept summary of the underlying principle.\n"
        "4. Return JSON only.\n\n"
        "REQUIRED JSON FORMAT:\n"
        "{\n"
        "  \"fixedCode\": \"...\",\n"
        "  \"explanation\": \"...\",\n"
        "  \"conceptSummary\": \"...\"\n"
        "}"
    )

    user_prompt = (
        f"Language: {language}\n"
        f"Error Code: {error_code}\n"
        f"Error Message: {message}\n\n"
        f"Source Code:\n```\n{source_code}\n```\n\n"
        "Generate the JSON response with the expert solution."
    )

    try:
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.3,
            max_tokens=1000,
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("Empty response from Groq")

        data = json.loads(content)

        # Validate required fields
        required_keys = ["fixedCode", "explanation", "conceptSummary"]
        for key in required_keys:
            if key not in data or not isinstance(data[key], str):
                raise ValueError(f"Missing or invalid field in Groq response: {key}")

        return SolutionResult(
            fixedCode=data["fixedCode"],
            explanation=data["explanation"],
            conceptSummary=data["conceptSummary"]
        )

    except Exception as exc:
        logger.error("Unexpected error during Groq solution generation: %s", exc)
        return SolutionResult(
            fixedCode=f"// Error generating fix: {exc}",
            explanation="An unexpected error occurred while generating the solution.",
            conceptSummary="Please try again or refer to documentation."
        )
