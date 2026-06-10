"""
schemas.py — Pydantic v2 request/response models for the Zero-Magic backend.

These models define the strict API contract between the VS Code extension
(missions.ts) and the FastAPI backend. Any field added or renamed here must
be reflected in the TypeScript `Mission` interface in src/missions.ts.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class MissionRequest(BaseModel):
    """
    Payload sent by the VS Code extension (missions.ts) when the student
    triggers the "💡 Help me think" Quick Fix on a compiler error.

    The extension POSTs this to POST /v1/missions/match so the backend can
    look up (or generate) an appropriate Socratic mission.

    Runtime-context fields (sourceCode, terminalOutput, exitCode,
    diagnosticMessage) are all optional with safe defaults so that existing
    callers that omit them continue to work without modification.
    """

    language: str = Field(
        ...,
        description=(
            "The programming language of the file that raised the error "
            "(e.g. 'python', 'javascript', 'typescript'). "
            "Matches vscode.TextDocument.languageId."
        ),
        examples=["python", "javascript", "typescript"],
    )

    errorCode: str = Field(
        ...,
        description=(
            "The short error-type identifier or diagnostic code produced by "
            "the language server (e.g. 'NameError', 'TypeError', "
            "'undefined_variable'). Used as the primary lookup key to find a "
            "matching mission in the static mission bank."
        ),
        examples=["NameError", "TypeError", "SyntaxError"],
    )

    message: str = Field(
        ...,
        description=(
            "The full human-readable error message text emitted by the "
            "compiler or linter (e.g. \"name 'x' is not defined\"). "
            "Passed to the LLM in Phase 7 Step 3 for context-aware mission "
            "generation when no static match is found."
        ),
        examples=["name 'x' is not defined", "cannot read property of undefined"],
    )

    # ── Runtime-context fields (all optional, default to empty/sentinel) ────

    diagnosticMessage: str = Field(
        default="",
        description=(
            "Full diagnostic message from the IDE language server. "
            "Takes priority over errorCode when non-empty. "
            "Alias for 'message' that the new ContextBuilder sends explicitly."
        ),
        examples=["NameError: name 'result' is not defined on line 5"],
    )

    sourceCode: str = Field(
        default="",
        description=(
            "Complete source code of the active file at the time the error "
            "was captured. Used by the Groq prompt to generate highly specific "
            "Socratic questions tied to the student's actual code."
        ),
    )

    terminalOutput: str = Field(
        default="",
        description=(
            "Combined stdout + stderr from the last terminal run. "
            "Takes highest priority in context resolution "
            "(terminalOutput > diagnosticMessage > errorCode). "
            "Empty string when no terminal execution has occurred."
        ),
        examples=["Traceback (most recent call last):\n  File 'app.py', line 5\nNameError: name 'result' is not defined"],
    )

    exitCode: int = Field(
        default=-1,
        description=(
            "Exit code of the last terminal process. "
            "-1 means no process has been run this session. "
            "0 means success; any other value indicates failure."
        ),
        examples=[-1, 0, 1],
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "language": "python",
                "errorCode": "NameError",
                "message": "name 'result' is not defined",
                "diagnosticMessage": "NameError: name 'result' is not defined",
                "sourceCode": "def compute():\n    x = 42\nprint(result)",
                "terminalOutput": "Traceback (most recent call last):\n  File 'app.py', line 5\nNameError: name 'result' is not defined",
                "exitCode": 1,
            }
        }
    }


# ---------------------------------------------------------------------------
# Response model
# ---------------------------------------------------------------------------

class MissionResponse(BaseModel):
    """
    The Socratic mission payload returned to the VS Code extension after a
    successful match or LLM generation.

    The extension uses every field here to populate the Socratic Dashboard
    sidebar (ui/sidebar.ts) and to write the hidden test file via
    interceptor.ts.
    """

    missionId: str = Field(
        ...,
        description=(
            "Stable, unique identifier for this mission "
            "(e.g. 'py_name_error_01'). "
            "Used by the extension to deduplicate triggers and by the "
            "unlock flow in interceptor.ts to clean up the correct test file."
        ),
        examples=["py_name_error_01", "js_type_error_02"],
    )

    title: str = Field(
        ...,
        description=(
            "Short, student-facing name for the mission shown as the "
            "dashboard heading (e.g. 'Variable Initialization Mastery'). "
            "Should be encouraging and concept-focused, not error-focused."
        ),
        examples=["Variable Initialization Mastery", "Type Safety Fundamentals"],
    )

    concept: str = Field(
        ...,
        description=(
            "One-paragraph plain-English explanation of the underlying "
            "programming concept the student needs to understand. Displayed "
            "in the sidebar's 'Concept' section. Must NOT contain the fix — "
            "only background knowledge."
        ),
        examples=[
            "In Python, every variable must be assigned a value before it can be read. "
            "Think of a variable as a labelled box — the label alone is not enough; "
            "you must put something inside the box before opening it."
        ],
    )

    questions: list[str] = Field(
        ...,
        description=(
            "Ordered list of Socratic questions the sidebar asks the student "
            "one at a time. Questions must guide thinking without revealing "
            "the answer. Minimum 2, maximum 5 questions."
        ),
        examples=[
            [
                "Before a computer can read what is inside a box, what must you do first?",
                "On which line did you first use this variable name?",
                "Did you ever write an assignment statement for it before that line?",
            ]
        ],
        min_length=2,
        max_length=5,
    )

    hints: list[str] = Field(
        ...,
        description=(
            "Progressive hints revealed one at a time in the sidebar when the "
            "student is stuck. Each hint should be more specific than the "
            "previous but still stop short of giving the solution code."
        ),
        examples=[
            [
                "Look at the left-hand side of an assignment statement.",
                "Did you spell the variable name exactly the same way in both places?",
                "The fix is a single line added before the first use.",
            ]
        ],
        min_length=1,
    )

    framework: str = Field(
        ...,
        description=(
            "The test framework the hidden test file should be run with. "
            "Determines which runner branch in runner.ts is executed. "
            "Accepted values: 'pytest' for Python missions, 'jest' for "
            "JavaScript/TypeScript missions."
        ),
        examples=["pytest", "jest"],
    )

    hiddenTest: str = Field(
        ...,
        description=(
            "The complete source code of the hidden unit-test file that "
            "interceptor.ts will write to .zero_magic/tests/. "
            "Must be a self-contained, runnable test that passes only when the "
            "student has correctly understood and applied the concept. "
            "No imports of the student's file are needed — assert fundamentals only."
        ),
        examples=[
            "def test_variable_initialized():\n"
            "    x = 0\n"
            "    assert isinstance(x, int), 'x must be assigned before use'"
        ],
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "missionId": "py_name_error_01",
                "title": "Variable Initialization Mastery",
                "concept": (
                    "In Python, every variable must be assigned a value before "
                    "it can be read. Think of a variable as a labelled box — "
                    "you must put something inside before you can open it."
                ),
                "questions": [
                    "Before a computer can read what is inside a box, what must you do first?",
                    "On which line did you first use this variable name?",
                    "Did you ever write an assignment statement for it before that line?",
                ],
                "hints": [
                    "Look at the left-hand side of an assignment statement.",
                    "Did you spell the variable name exactly the same way in both places?",
                ],
                "framework": "pytest",
                "hiddenTest": (
                    "def test_variable_initialized():\n"
                    "    x = 0\n"
                    "    assert isinstance(x, int)"
                ),
            }
        }
    }


# ---------------------------------------------------------------------------
# Expert Solution Models
# ---------------------------------------------------------------------------

class SolutionRequest(BaseModel):
    language: str = Field(...)
    errorCode: str = Field(...)
    sourceCode: str = Field(...)
    diagnosticMessage: str = Field(...)

class SolutionResponse(BaseModel):
    fixedCode: str = Field(...)
    explanation: str = Field(...)
    conceptSummary: str = Field(...)

# ---------------------------------------------------------------------------
# File Analysis Request Model
# ---------------------------------------------------------------------------

class FileAnalysisRequest(BaseModel):
    language: str = Field(
        ...,
        description="The programming language of the full file context.",
        examples=["python", "javascript", "typescript"],
    )
    fullCode: str = Field(
        ...,
        description="The complete source code of the file.",
        examples=["def main():\n    print('hello world')"],
    )
