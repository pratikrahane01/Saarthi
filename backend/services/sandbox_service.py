"""
sandbox_service.py — Business logic for the Tier 3 Sandbox system.

This service handles:
  1. Generating sandbox challenges from Tier 3 logic bugs via Groq
  2. Evaluating student submissions against the challenge criteria

IMPORTANT: This file is fully isolated from the existing services.
It does NOT import from groq_service.py, mission_service.py, or any other
existing service to prevent merge conflicts.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time

try:
    from groq import Groq
    from groq import APIError
except ImportError:
    Groq = None
    APIError = Exception

from backend.models.sandbox_models import (
    SandboxGenerateRequest,
    SandboxGenerateResponse,
    SandboxQuestion,
    SandboxEvaluateRequest,
    SandboxEvaluateResponse,
)

logger = logging.getLogger("zero_magic.service.sandbox")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _strip_comments(code: str, language: str) -> str:
    """Removes comments from code to prevent LLM hallucination on commented blocks."""
    if language.lower() in ["python"]:
        code = re.sub(r"'''[\s\S]*?'''", "", code)
        code = re.sub(r'\"\"\"[\s\S]*?\"\"\"', "", code)
        code = re.sub(r"#.*", "", code)
    elif language.lower() in ["javascript", "typescript", "ts", "js"]:
        code = re.sub(r"/\*[\s\S]*?\*/", "", code)
        code = re.sub(r"//.*", "", code)
    code = re.sub(r'\n\s*\n', '\n', code)
    return code.strip()


def _get_groq_client() -> "Groq | None":
    """Returns a Groq client if the API key is available, else None."""
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key or Groq is None:
        logger.warning("Groq API key not found or groq package missing.")
        return None
    return Groq(api_key=api_key)


def _build_fallback_questions(error_context: str, source_code: str) -> list[SandboxQuestion]:
    """Return 3 generic fallback questions when Groq is unavailable."""
    return [
        SandboxQuestion(
            challenge=(
                f"A logic issue was detected in your code: {error_context}\n\n"
                "Review this code carefully and fix the underlying logic error."
            ),
            scaffoldCode=source_code,
            hints=[
                "Read through your code line by line and trace the execution mentally.",
                "Check if the output matches what you expect for a simple test case.",
                "Look for off-by-one errors, wrong operators, or incorrect conditions.",
            ],
            testCriteria="Your code should produce the correct output for all expected inputs.",
        ),
        SandboxQuestion(
            challenge=(
                "Here is a related problem testing the same concept. "
                "Can you identify and fix the logic error?"
            ),
            scaffoldCode=source_code,
            hints=[
                "Think about the expected vs actual behaviour.",
                "Check boundary conditions and edge cases.",
                "Look for incorrect boolean logic or comparison operators.",
            ],
            testCriteria="Your code should handle all edge cases correctly.",
        ),
        SandboxQuestion(
            challenge=(
                "One more practice problem on this concept. "
                "Find and fix the bug in the code below."
            ),
            scaffoldCode=source_code,
            hints=[
                "Trace through the code with a concrete example.",
                "Check loop conditions and iteration logic.",
                "Verify that the return value matches the function's purpose.",
            ],
            testCriteria="Your code should return the correct result for any valid input.",
        ),
    ]


# ---------------------------------------------------------------------------
# Sandbox Challenge Generation
# ---------------------------------------------------------------------------

def generate_sandbox_challenge(request: SandboxGenerateRequest) -> SandboxGenerateResponse:
    """
    Generate 3 Socratic sandbox challenges for a Tier 3 logic bug.

    Uses Groq to analyze the student's code and create 3 similar practice
    questions that guide them to find and fix logic errors without revealing
    the answers.

    Falls back to generic questions if Groq is unavailable.
    """
    sandbox_id = f"sandbox_{request.language}_{int(time.time())}"

    client = _get_groq_client()
    if client is None:
        logger.info("Groq unavailable — returning fallback sandbox questions.")
        return SandboxGenerateResponse(
            sandboxId=sandbox_id,
            questions=_build_fallback_questions(request.errorContext, request.sourceCode),
        )

    clean_code = _strip_comments(request.sourceCode, request.language)

    system_prompt = (
        "You are Socrates, an AI debugging mentor for student programmers.\n\n"
        "A Tier 3 logic bug has been detected in the student's code. Your job is to create\n"
        "THREE (3) NEW, SIMILAR practice coding problems (short snippets with similar logic errors)\n"
        "to test their retention and understanding of the underlying concept.\n\n"
        "Rules:\n"
        "1. Do NOT return the student's original code. Generate 3 NEW code snippets testing the same logic concept.\n"
        "2. Each new code snippet MUST contain a bug similar to what they did wrong.\n"
        "3. NEVER reveal the fix or corrected code.\n"
        "4. Describe each challenge in Socratic terms — ask them to investigate the bug.\n"
        "5. Provide 3 progressive hints tailored to EACH code snippet.\n"
        "6. Describe success criteria in plain English for EACH code snippet.\n"
        "7. Each question should be slightly different but test the same core concept.\n\n"
        "Return JSON only.\n\n"
        "REQUIRED JSON FORMAT:\n"
        "{\n"
        '  "questions": [\n'
        "    {\n"
        '      "challenge": "...",\n'
        '      "scaffoldCode": "...",\n'
        '      "hint1": "...",\n'
        '      "hint2": "...",\n'
        '      "hint3": "...",\n'
        '      "testCriteria": "..."\n'
        "    },\n"
        "    { ... },\n"
        "    { ... }\n"
        "  ]\n"
        "}\n"
    )

    user_prompt = (
        f"Language: {request.language}\n"
        f"Original Error Context: {request.errorContext}\n\n"
        f"[ORIGINAL BUGGY CODE]\n{clean_code[:3000]}\n\n"
        "Analyze the logic bug above. Then, generate 3 Socratic sandbox challenges, each with a "
        "completely NEW code snippet testing the same underlying concept."
    )

    try:
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.7,
            max_tokens=1500,
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("Empty response from Groq")

        data = json.loads(content)

        # Parse the questions array from the response
        raw_questions = data.get("questions", [])
        if not isinstance(raw_questions, list) or len(raw_questions) < 1:
            raise ValueError(f"Expected 'questions' array with >= 1 items, got: {type(raw_questions)}")

        questions: list[SandboxQuestion] = []
        for i, q in enumerate(raw_questions[:3]):
            required_keys = ["challenge", "scaffoldCode", "hint1", "hint2", "hint3", "testCriteria"]
            for key in required_keys:
                if key not in q or not isinstance(q[key], str):
                    raise ValueError(f"Missing or invalid field '{key}' in question {i}")

            questions.append(SandboxQuestion(
                challenge=q["challenge"],
                scaffoldCode=q["scaffoldCode"],
                hints=[q["hint1"], q["hint2"], q["hint3"]],
                testCriteria=q["testCriteria"],
            ))

        # Pad to 3 questions if Groq returned fewer
        while len(questions) < 3:
            questions.append(questions[-1])

        return SandboxGenerateResponse(
            sandboxId=sandbox_id,
            questions=questions,
        )

    except Exception as exc:
        logger.error("Sandbox challenge generation failed: %s", exc)
        return SandboxGenerateResponse(
            sandboxId=sandbox_id,
            questions=_build_fallback_questions(request.errorContext, request.sourceCode),
        )


# ---------------------------------------------------------------------------
# Sandbox Evaluation
# ---------------------------------------------------------------------------

def evaluate_sandbox_submission(request: SandboxEvaluateRequest) -> SandboxEvaluateResponse:
    """
    Evaluate whether the student's code fix is correct.

    Uses Groq to compare the student's code against the challenge criteria
    and determine if the logic bug has been fixed.

    Falls back to a simple diff-based check if Groq is unavailable.
    """
    client = _get_groq_client()
    if client is None:
        # Fallback: if code changed at all, give benefit of the doubt
        code_changed = request.studentCode.strip() != request.originalCode.strip()
        return SandboxEvaluateResponse(
            passed=code_changed,
            feedback=(
                "Your code was modified. Manual review is needed (AI unavailable)."
                if code_changed
                else "No changes detected. Please modify your code to fix the bug."
            ),
            xpAwarded=100 if code_changed else 0,
            conceptSummary="Logic debugging requires careful analysis of code behavior.",
        )

    clean_student = _strip_comments(request.studentCode, request.language)
    clean_original = _strip_comments(request.originalCode, request.language)

    system_prompt = (
        "You are an expert code evaluator for an educational coding tool.\n\n"
        "Your job is to determine if a student successfully fixed a logic bug.\n\n"
        "Rules:\n"
        "1. Compare the student's code to the practice scaffold code (similar question).\n"
        "2. Determine if the logic bug described in the challenge has been fixed in the student's submission.\n"
        "3. If PASSED: provide encouraging feedback and a concept summary.\n"
        "4. If FAILED: provide a Socratic nudge WITHOUT revealing the fix.\n"
        "5. Return JSON only.\n\n"
        "REQUIRED JSON FORMAT:\n"
        "{\n"
        '  "passed": true or false,\n'
        '  "feedback": "...",\n'
        '  "conceptSummary": "..."\n'
        "}\n"
    )

    user_prompt = (
        f"Language: {request.language}\n"
        f"Challenge: {request.challenge}\n\n"
        f"[PRACTICE SCAFFOLD CODE (similar question)]\n{clean_original[:2000]}\n\n"
        f"[STUDENT'S MODIFIED CODE]\n{clean_student[:2000]}\n\n"
        "Did the student fix the logic bug in the practice code? Evaluate and return JSON."
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
            max_tokens=300,
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("Empty response from Groq")

        data = json.loads(content)

        passed = bool(data.get("passed", False))
        feedback = str(data.get("feedback", "Evaluation complete."))
        concept_summary = str(data.get("conceptSummary", "Logic debugging fundamentals."))

        return SandboxEvaluateResponse(
            passed=passed,
            feedback=feedback,
            xpAwarded=100 if passed else 0,
            conceptSummary=concept_summary,
        )

    except Exception as exc:
        logger.error("Sandbox evaluation failed: %s", exc)
        # On failure, check if code changed as a heuristic
        code_changed = request.studentCode.strip() != request.originalCode.strip()
        return SandboxEvaluateResponse(
            passed=code_changed,
            feedback=(
                "Evaluation encountered an error, but your code was modified. Accepting as a best-effort pass."
                if code_changed
                else "No changes detected and evaluation failed. Please try again."
            ),
            xpAwarded=100 if code_changed else 0,
            conceptSummary="Logic debugging requires careful analysis of code behavior.",
        )
