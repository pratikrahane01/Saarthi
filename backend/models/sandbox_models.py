"""
sandbox_models.py — Pydantic v2 request/response models for the Tier 3 Sandbox system.

These models define the API contract for the Sandbox endpoints.
They are fully isolated from the existing mission models in schemas.py.

IMPORTANT: This file must NOT import from schemas.py to maintain isolation.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Sandbox Generation Models
# ---------------------------------------------------------------------------

class SandboxGenerateRequest(BaseModel):
    """
    Payload sent by the VS Code extension (sandboxApi.ts) when a Tier 3
    mission is encountered. The backend generates a sandbox challenge that
    the student must solve.
    """

    language: str = Field(
        ...,
        description="The programming language of the file (e.g. 'python', 'javascript').",
        examples=["python", "javascript"],
    )
    sourceCode: str = Field(
        ...,
        description="Complete source code of the active file at the time the Tier 3 bug was detected.",
    )
    errorContext: str = Field(
        ...,
        description=(
            "The original error message, concept, or logic bug description "
            "that was classified as Tier 3."
        ),
        examples=["The function does not handle edge cases for empty lists."],
    )
    tier: int = Field(
        default=3,
        description="Always 3 for sandbox requests. Included for validation.",
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "language": "python",
                "sourceCode": "def add(a, b):\n    return a - b\n",
                "errorContext": "The add function subtracts instead of adding.",
                "tier": 3,
            }
        }
    }


class SandboxGenerateResponse(BaseModel):
    """
    The sandbox challenge payload returned to the VS Code extension.
    Contains everything needed to render the Sandbox UI panel.
    """

    sandboxId: str = Field(
        ...,
        description="Unique identifier for this sandbox session.",
        examples=["sandbox_py_logic_1718000000"],
    )
    challenge: str = Field(
        ...,
        description=(
            "A Socratic challenge description explaining what the student "
            "needs to investigate and fix. Does NOT reveal the answer."
        ),
    )
    scaffoldCode: str = Field(
        ...,
        description="Code scaffold for the student to work with — typically the original code.",
    )
    hints: list[str] = Field(
        ...,
        description="Progressive hints for the student (max 3).",
        min_length=1,
    )
    testCriteria: str = Field(
        ...,
        description=(
            "A plain-English description of what the evaluation will check, "
            "so the student knows the success criteria without seeing the tests."
        ),
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "sandboxId": "sandbox_py_logic_1718000000",
                "challenge": "This function claims to add two numbers, but the test suite disagrees. Can you find the logical error?",
                "scaffoldCode": "def add(a, b):\n    return a - b\n",
                "hints": [
                    "Look at the arithmetic operator on the return line.",
                    "What operation does '-' perform compared to '+'?",
                    "The function name says 'add' but the operator says otherwise.",
                ],
                "testCriteria": "The function should return the sum of its two arguments for any pair of numbers.",
            }
        }
    }


# ---------------------------------------------------------------------------
# Sandbox Evaluation Models
# ---------------------------------------------------------------------------

class SandboxEvaluateRequest(BaseModel):
    """
    Payload sent when the student submits their fix from the sandbox panel.
    The backend evaluates whether the fix is correct.
    """

    sandboxId: str = Field(
        ...,
        description="The sandbox session ID from the generation response.",
    )
    language: str = Field(
        ...,
        description="Programming language of the code.",
        examples=["python", "javascript"],
    )
    studentCode: str = Field(
        ...,
        description="The student's modified code after attempting the fix.",
    )
    originalCode: str = Field(
        ...,
        description="The original (buggy) code for comparison.",
    )
    challenge: str = Field(
        ...,
        description="The challenge description for context during evaluation.",
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "sandboxId": "sandbox_py_logic_1718000000",
                "language": "python",
                "studentCode": "def add(a, b):\n    return a + b\n",
                "originalCode": "def add(a, b):\n    return a - b\n",
                "challenge": "This function claims to add two numbers, but the test suite disagrees.",
            }
        }
    }


class SandboxEvaluateResponse(BaseModel):
    """
    Result of the sandbox evaluation returned to the VS Code extension.
    """

    passed: bool = Field(
        ...,
        description="True if the student's fix is correct.",
    )
    feedback: str = Field(
        ...,
        description=(
            "Socratic feedback explaining what was right or wrong about "
            "the student's approach. Does NOT provide the fix if failed."
        ),
    )
    xpAwarded: int = Field(
        ...,
        description="XP points awarded for this submission (0 if failed).",
        examples=[0, 100],
    )
    conceptSummary: str = Field(
        ...,
        description="A brief educational summary of the concept being tested.",
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "passed": True,
                "feedback": "Excellent! You correctly identified the arithmetic operator error.",
                "xpAwarded": 100,
                "conceptSummary": "Arithmetic operators: '+' adds, '-' subtracts. Always verify operator semantics match intent.",
            }
        }
    }
