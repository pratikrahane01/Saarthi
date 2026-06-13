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

    brokenLine: str | None = Field(
        default=None,
        description="The exact broken line from the editor for Tier 1 isolation.",
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

    lineNumber: int | None = Field(
        default=None,
        description="The line number where the error occurred.",
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

    solutionBefore: str = Field(
        default="",
        description="The exact broken snippet or line from the user's code. Empty for Tier 3 logic missions."
    )

    solutionAfter: str = Field(
        default="",
        description="The exact corrected snippet or line. Empty for Tier 3 logic missions."
    )

    solutionExplanation: str = Field(
        default="",
        description="A concise, educational explanation of why the fix resolves the diagnostic. Empty for Tier 3 logic missions."
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

class DiagnosticInput(BaseModel):
    lineNumber: int
    message: str
    errorCode: str
    severity: str

class AnalyzeAllRequest(BaseModel):
    language: str
    fullCode: str
    diagnostics: list[DiagnosticInput] = Field(default_factory=list)

class UnifiedFinding(BaseModel):
    source: str = Field(..., description="The source of the finding: 'diagnostic', 'ast', or 'llm'")
    category: str = Field(..., description="e.g., 'Syntax', 'Runtime', 'Logic'")
    confidence: float = Field(..., ge=0.0, le=1.0)
    severity: str = Field(..., description="e.g., 'Tier 1', 'Tier 2', 'Tier 3'")
    lineNumber: int = Field(default=0)
    concept: str = Field(...)
    socraticQuestion: str = Field(...)
    hints: list[str] = Field(default_factory=list)

class MissionQueueResponse(BaseModel):
    missions: list[UnifiedFinding] = Field(...)



# ---------------------------------------------------------------------------
# Tier Classification Models
# ---------------------------------------------------------------------------

class TierClassifyRequest(BaseModel):
    """
    Payload for POST /v1/missions/classify-tier.

    Sent by the VS Code extension immediately after a diagnostic event is
    captured. The backend uses GROQ_API_KEY1 (dedicated classifier key) plus
    a regex fast-path to determine which tier of error assistance to display.
    """

    language: str = Field(
        ...,
        description="Programming language of the file that raised the error.",
        examples=["python", "javascript"],
    )
    errorCode: str = Field(
        ...,
        description="Short error-type identifier (e.g. 'TypeError', 'SyntaxError').",
        examples=["TypeError", "SyntaxError", "NameError"],
    )
    message: str = Field(
        ...,
        description="Full human-readable error message from the IDE diagnostic.",
        examples=["name 'x' is not defined"],
    )
    terminalOutput: str = Field(
        default="",
        description="Combined stdout + stderr from the last terminal run.",
    )
    sourceCode: str = Field(
        default="",
        description="Complete source of the active file (improves LLM accuracy).",
    )
    lineNumber: int = Field(
        default=0,
        description="Line number where the error occurred (0 = unknown).",
        examples=[14, 42, 0],
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "language": "python",
                "errorCode": "TypeError",
                "message": "'NoneType' object is not subscriptable",
                "terminalOutput": "Traceback (most recent call last):\n  File 'app.py', line 14\nTypeError: 'NoneType' object is not subscriptable",
                "sourceCode": "data = fetch_data()\nprint(data[0])",
                "lineNumber": 14,
            }
        }
    }


class TierClassifyResponse(BaseModel):
    """
    Result of tier classification returned to the VS Code extension.

    The extension uses `tier` to decide which sidebar card to render:
      1 → lightweight TIER1_NUDGE card (no API, instant)
      2 → TIER2_ANALYSIS card + opt-in [Deep Dive] button
      3 → auto-trigger DEEP_DIVE mode
    """

    tier: int = Field(
        ...,
        description="Error tier: 1 = Syntax Nudge, 2 = Analysis Card, 3 = Deep Dive.",
        examples=[1, 2, 3],
    )
    errorFlag: str = Field(
        ...,
        description="Human-readable one-liner: 'Line N: ErrorCode: message'.",
        examples=["Line 14: TypeError: 'NoneType' object is not subscriptable"],
    )
    proTip: str = Field(
        default="",
        description="Curated tip for Tier 1 errors. Empty string for Tier 2/3.",
        examples=["Tip: Read the caret in the traceback — it points to the rejected character."],
    )
    explanation: str = Field(
        default="",
        description="One-sentence rationale for the tier assignment (Tier 2/3). Empty for Tier 1.",
        examples=["TypeError at runtime indicates a semantic type mismatch, not a syntax issue."],
    )
    source: str = Field(
        default="fallback",
        description="How the tier was determined: 'regex', 'llm', or 'fallback'.",
        examples=["llm", "regex", "fallback"],
    )
    apiUsed: str = Field(
        default="none",
        description="Which API was used for classification (e.g., 'groq', 'none').",
        examples=["groq", "none"],
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "tier": 2,
                "errorFlag": "Line 14: TypeError: 'NoneType' object is not subscriptable",
                "proTip": "",
                "explanation": "TypeError at runtime — data flow issue, not a syntax problem.",
                "source": "llm",
                "apiUsed": "groq",
            }
        }
    }


# ---------------------------------------------------------------------------
# Ritual Context Models
# ---------------------------------------------------------------------------

class ErrorLine(BaseModel):
    """A single line of source code that is a suspect for the error."""
    line: int = Field(..., description="1-indexed line number.")
    text: str = Field(..., description="The text content of that line.")


class RitualContextRequest(BaseModel):
    """Payload for POST /v1/missions/ritual-context."""

    language: str = Field(..., examples=["python"])
    errorCode: str = Field(..., examples=["TypeError"])
    message: str = Field(..., examples=["name 'x' is not defined"])
    lineNumber: int = Field(default=0, examples=[14])
    sourceCode: str = Field(default="")
    terminalOutput: str = Field(default="")


class RitualContextResponse(BaseModel):
    """
    Read-only content shown during the Debug Ritual.
    Step 1 shows errorSummary; Step 2 shows errorLines.
    """
    errorSummary: str = Field(
        ...,
        description="Plain-English 2-3 sentence explanation of the error (no code, no fix).",
    )
    errorLines: list[ErrorLine] = Field(
        default_factory=list,
        description="Source lines near the error that the student should examine.",
    )
    fallback: bool = Field(
        default=False,
        description="True if the Groq API was unavailable and defaults were used.",
    )

# ---------------------------------------------------------------------------
# Evaluate Hypothesis Models
# ---------------------------------------------------------------------------

class EvaluateHypothesisRequest(BaseModel):
    """Payload for POST /v1/missions/evaluate-hypothesis."""
    user_hypothesis: str
    actual_error: str
    code_snippet: str

class EvaluateHypothesisResponse(BaseModel):
    """Result of hypothesis evaluation."""
    status: str = Field(..., description="PASS, CLOSE, or FAIL")
    nudge: str = Field(..., description="Socratic nudge or empty string")


# ---------------------------------------------------------------------------
# Analyze Errors (Multi-Region) Models
# ---------------------------------------------------------------------------

class AnalyzeErrorsRequest(BaseModel):
    """Payload for POST /v1/missions/analyze-errors.

    The extension sends source code + error context after a Tier 2
    classification. The backend identifies 2-4 suspect regions in the code.
    """
    language: str = Field(..., examples=["python"])
    errorCode: str = Field(..., examples=["TypeError"])
    message: str = Field(..., examples=["'NoneType' object is not subscriptable"])
    sourceCode: str = Field(..., description="Complete source code of the active file.")
    lineNumber: int = Field(default=0, description="Line where the primary error was reported.")
    terminalOutput: str = Field(default="", description="Terminal output if available.")


class ErrorRegion(BaseModel):
    """A single suspect region in the source code."""
    lineStart: int = Field(..., description="1-indexed start line of the suspect region.")
    lineEnd: int = Field(..., description="1-indexed end line (same as lineStart for single-line).")
    meaning: str = Field(
        ...,
        description="Plain-English 1-2 sentence explanation of what might be wrong here.",
    )
    formattedRange: str = Field(
        ...,
        description="Line range formatted exactly as ' #L<start> - <end> ' or ' #L<start> '.",
    )


class AnalyzeErrorsResponse(BaseModel):
    """Response from POST /v1/missions/analyze-errors.

    Contains 2-4 suspect regions the student should investigate.
    """
    regions: list[ErrorRegion] = Field(
        ...,
        description="Ordered list of suspect code regions with explanations.",
        min_length=1,
        max_length=6,
    )

