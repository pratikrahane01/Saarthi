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
        "identifiers from the code in your question.\n"
        "8. IGNORE all commented out lines of code (such as those starting with #, //, or enclosed in ''' or \"\"\").\n\n"
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
    source_clean = strip_comments(source_code, language) if source_code else ""
    terminal_clean = terminal_output.strip() if terminal_output else ""

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
        "4. IGNORE all commented out lines of code (such as those starting with #, //, or enclosed in ''' or \"\"\").\n"
        "5. Return JSON only.\n\n"
        "REQUIRED JSON FORMAT:\n"
        "{\n"
        "  \"fixedCode\": \"...\",\n"
        "  \"explanation\": \"...\",\n"
        "  \"conceptSummary\": \"...\"\n"
        "}"
    )

    clean_source = strip_comments(source_code, language) if source_code else ""
    user_prompt = (
        f"Language: {language}\n"
        f"Error Code: {error_code}\n"
        f"Error Message: {message}\n\n"
        f"Source Code:\n```\n{clean_source}\n```\n\n"
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

# ---------------------------------------------------------------------------
# File-Level Socratic Analysis
# ---------------------------------------------------------------------------

import re

def strip_comments(code: str, language: str) -> str:
    """Removes comments from code to prevent LLM hallucination on commented blocks."""
    if language.lower() in ["python"]:
        # Remove multi-line strings used as comments
        code = re.sub(r"'''[\s\S]*?'''", "", code)
        code = re.sub(r'\"\"\"[\s\S]*?\"\"\"', "", code)
        # Remove single-line comments
        code = re.sub(r"#.*", "", code)
    elif language.lower() in ["javascript", "typescript", "ts", "js"]:
        # Remove multi-line comments
        code = re.sub(r"/\*[\s\S]*?\*/", "", code)
        # Remove single-line comments
        code = re.sub(r"//.*", "", code)
    
    # Remove excessive blank lines left behind
    code = re.sub(r'\n\s*\n', '\n', code)
    return code.strip()

def generate_file_mission(language: str, full_code: str) -> DynamicMissionResult:
    """
    Call the Groq API to dynamically generate a Socratic mission based on the
    entire source code file.
    """
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key or Groq is None:
        logger.warning("Groq API key not found or groq package missing. Using generic fallback.")
        return _build_generic_mission(language, "FILE_ANALYSIS")

    client = Groq(api_key=api_key)
    
    # Pre-process code to force LLM to ignore comments
    clean_code = strip_comments(full_code, language)

    system_prompt = (
        "You are Socrates, an AI debugging mentor.\n\n"
        "Rules:\n\n"
        "1. Never provide corrected code.\n"
        "2. Never provide direct fixes.\n"
        "3. Analyze the provided full program.\n"
        "4. Identify the most important concept the student should learn or a potential bug.\n"
        "5. Explain this underlying concept briefly.\n"
        "6. Ask one Socratic question to guide the student.\n"
        "7. Generate:\n"
        "   - Hint Level 1\n"
        "   - Hint Level 2\n"
        "   - Hint Level 3\n"
        "8. IGNORE all commented out lines of code (such as those starting with #, //, or enclosed in ''' or \"\"\").\n\n"
        "Return JSON only.\n\n"
        "Focus on teaching debugging skills and software design.\n\n"
        "REQUIRED JSON FORMAT:\n"
        "{\n"
        "  \"concept\": \"...\",\n"
        "  \"question\": \"...\",\n"
        "  \"hintLevel1\": \"...\",\n"
        "  \"hintLevel2\": \"...\",\n"
        "  \"hintLevel3\": \"...\"\n"
        "}"
    )

    user_prompt = (
        f"Language: {language}\n\n"
        f"Full Source Code:\n```\n{clean_code}\n```\n\n"
        "Generate the Socratic JSON response for this file."
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
            max_tokens=600,
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("Empty response from Groq")

        data = json.loads(content)

        required_keys = ["concept", "question", "hintLevel1", "hintLevel2", "hintLevel3"]
        for key in required_keys:
            if key not in data or not isinstance(data[key], str):
                raise ValueError(f"Missing or invalid field in Groq response: {key}")

        return DynamicMissionResult(
            concept=data["concept"],
            questions=[data["question"], "Which part of the file should you review first?"],
            hints=[data["hintLevel1"], data["hintLevel2"], data["hintLevel3"]]
        )

    except Exception as exc:
        logger.error("Unexpected error during Groq file analysis generation: %s", exc)
        return _build_generic_mission(language, "FILE_ANALYSIS")


# ---------------------------------------------------------------------------
# Ritual Context Generation (Debug Ritual Step 1 & 2 content)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RitualContextResult:
    """
    Content for the Debug Ritual's informational steps.

    error_summary:  Plain-English summary of what went wrong (Step 1).
    error_lines:    List of dicts with {"line": int, "text": str} for suspect lines (Step 2).
    fallback:       True if the API was unreachable and defaults were used.
    """
    error_summary: str
    error_lines: list[dict]
    fallback: bool = False


def generate_ritual_context(
    language: str,
    error_code: str,
    message: str,
    source_code: str = "",
    line_number: int = 0,
    terminal_output: str = "",
) -> RitualContextResult:
    """
    Use Groq to produce a plain-English error summary and a list of
    suspect source lines for the Debug Ritual's read-only info panels.

    Returns a safe fallback if the API is unavailable.
    """
    api_key = os.environ.get("GROQ_API_KEY")

    # ── Build suspect lines from source_code + line_number even without API ──
    suspect_lines: list[dict] = []
    if source_code and line_number > 0:
        lines = source_code.splitlines()
        # Show the 2 lines before and 2 after the error line (clamped to file bounds)
        start = max(0, line_number - 3)
        end   = min(len(lines), line_number + 2)
        for i in range(start, end):
            suspect_lines.append({"line": i + 1, "text": lines[i]})

    if not api_key or Groq is None:
        logger.warning("Groq API key not found — using fallback ritual context.")
        fallback_summary = (
            f"Your code has a {error_code}. "
            f"The error message says: \"{message}\". "
            "Look at the highlighted lines below and think about what might be wrong."
        )
        return RitualContextResult(
            error_summary=fallback_summary,
            error_lines=suspect_lines,
            fallback=True,
        )

    client = Groq(api_key=api_key)

    clean_source = strip_comments(source_code, language) if source_code else ""
    source_snippet = ""
    if clean_source:
        src_lines = clean_source.splitlines()
        # Only send the relevant window to stay within token budget
        s = max(0, line_number - 5)
        e = min(len(src_lines), line_number + 5)
        source_snippet = "\n".join(
            f"Line {s + idx + 1}: {l}" for idx, l in enumerate(src_lines[s:e])
        )

    system_prompt = (
        "You are a concise, friendly coding tutor helping a student understand their error.\n\n"
        "You MUST return a single JSON object with exactly these two keys:\n"
        "  \"error_summary\": A 2-3 sentence plain-English explanation of what went wrong. "
        "NO code. NO technical jargon. Write as if explaining to a friend. "
        "Do NOT reveal the fix — just explain what the error means.\n"
        "  \"suspect_line_range\": A string describing which line(s) to look at, "
        "e.g. 'Lines 18-20' or 'Line 14'. Be concise.\n\n"
        "Return JSON only. No markdown, no extra text."
    )

    terminal_part = f"\nTerminal Output:\n{terminal_output[:500]}" if terminal_output else ""
    source_part   = f"\nCode near the error:\n{source_snippet}" if source_snippet else ""
    line_part     = f"\nError on line: {line_number}" if line_number else ""

    user_prompt = (
        f"Language: {language}\n"
        f"Error Type: {error_code}\n"
        f"Error Message: {message}"
        f"{line_part}"
        f"{terminal_part}"
        f"{source_part}"
    )

    try:
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.4,
            max_tokens=300,
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("Empty Groq response")

        data = json.loads(content)
        summary = data.get("error_summary", message)
        # Ignore suspect_line_range from LLM — we already computed suspect_lines from source

        return RitualContextResult(
            error_summary=summary,
            error_lines=suspect_lines,
        )

    except Exception as exc:
        logger.error("Ritual context generation failed: %s", exc)
        fallback_summary = (
            f"Your code raised a {error_code}. "
            f"The error message says: \"{message}\". "
            "Look at the highlighted lines and think about what could cause this."
        )
        return RitualContextResult(
            error_summary=fallback_summary,
            error_lines=suspect_lines,
            fallback=True,
        )

# ---------------------------------------------------------------------------
# Evaluate Hypothesis
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class HypothesisResult:
    status: str
    nudge: str

async def evaluate_hypothesis_llm(
    user_hypothesis: str,
    actual_error: str,
    code_snippet: str
) -> dict[str, str]:
    """
    Evaluates a user hypothesis.
    Returns {"status": "PASS"|"CLOSE"|"FAIL", "nudge": "..."}
    """
    api_key = os.environ.get("GROQ_API_KEY1")
    
    if not api_key or Groq is None:
        logger.warning("Groq API key not found — auto-passing hypothesis.")
        return {"status": "PASS", "nudge": ""}

    system_prompt = (
        "You are the Socratic Gatekeeper for an educational coding tool.\n"
        "Your job is to evaluate a student's hypothesis about a code error.\n\n"
        "You must classify their hypothesis into exactly one of three categories:\n"
        "1. \"PASS\": The student understands the root cause of the error.\n"
        "2. \"CLOSE\": The student is on the right track but missing a critical detail.\n"
        "3. \"FAIL\": The student is incorrect or guessing blindly.\n\n"
        "CRITICAL RULES:\n"
        "- DO NOT give away the answer, write code for them, or explain the fix.\n"
        "- If \"PASS\", leave the nudge empty.\n"
        "- If \"CLOSE\" or \"FAIL\", provide a strictly 1-sentence Socratic nudge (a question or observation) to guide them to the next logical step without revealing the solution.\n"
        "- Output MUST be strictly valid JSON matching the schema below. Do not wrap in markdown blocks.\n\n"
        "JSON SCHEMA:\n"
        "{\n"
        "    \"status\": \"PASS\" | \"CLOSE\" | \"FAIL\",\n"
        "    \"nudge\": \"1-sentence question or empty string\"\n"
        "}"
    )

    user_prompt = (
        f"Actual Error: {actual_error}\n"
        f"Code Snippet:\n{code_snippet}\n"
        f"---\n"
        f"Student's Hypothesis: {user_hypothesis}"
    )

    try:
        from groq import AsyncGroq
        client = AsyncGroq(api_key=api_key)
        response = await client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=150
        )
        
        raw_content = response.choices[0].message.content
        if not raw_content:
            return {"status": "PASS", "nudge": ""}

        result = json.loads(raw_content)
        status = result.get("status", "FAIL").upper()
        if status not in ["PASS", "CLOSE", "FAIL"]:
            status = "FAIL"
            
        return {
            "status": status,
            "nudge": result.get("nudge", "Think deeper about the error message and the code block.")
        }
        
    except Exception as e:
        logger.error("Failed to evaluate hypothesis: %s", e)
        return {"status": "PASS", "nudge": ""}


# ---------------------------------------------------------------------------
# Multi-Error Region Analysis (Tier 2)
# ---------------------------------------------------------------------------

from backend.models.schemas import ErrorRegion

def analyze_error_regions(
    language: str,
    error_code: str,
    message: str,
    source_code: str,
    line_number: int,
    terminal_output: str
) -> list[ErrorRegion]:
    """
    Analyzes the source code to identify 2-4 suspect regions where the
    error could originate. Returns a list of ErrorRegion objects.
    """
    api_key = os.environ.get("GROQ_API_KEY1") or os.environ.get("GROQ_API_KEY")
    
    # Base fallback if API is unavailable or fails
    fallback_region = ErrorRegion(
        lineStart=line_number if line_number > 0 else 1,
        lineEnd=line_number if line_number > 0 else 1,
        meaning=f"The primary error was reported here: {message}. Look closely at the logic."
    )

    if not api_key or Groq is None:
        logger.warning("Groq API key not found — returning fallback error region.")
        return [fallback_region]

    client = Groq(api_key=api_key)
    
    clean_source = strip_comments(source_code, language) if source_code else ""
    
    system_prompt = (
        "You are an expert debugging assistant.\n"
        "Your task is to analyze a source code file and an error message, and identify "
        "2 to 4 suspect regions (line ranges) where the root cause of the error could be.\n\n"
        "RULES:\n"
        "1. Return 2 to 4 suspect regions.\n"
        "2. For each region, provide `lineStart`, `lineEnd`, and a `meaning`.\n"
        "3. `meaning` MUST be a plain-English 1-2 sentence explanation of what might be wrong at that location. "
        "Do NOT reveal the exact fix, just explain the potential problem.\n"
        "4. Output MUST be valid JSON matching this schema:\n"
        "{\n"
        "  \"regions\": [\n"
        "    { \"lineStart\": int, \"lineEnd\": int, \"meaning\": str }\n"
        "  ]\n"
        "}\n\n"
        "Do NOT wrap the JSON in markdown blocks. Return JSON only."
    )
    
    terminal_part = f"\nTerminal Output:\n{terminal_output[:1000]}" if terminal_output else ""
    line_part = f"\nError reported on line: {line_number}" if line_number > 0 else ""
    
    user_prompt = (
        f"Language: {language}\n"
        f"Error Type: {error_code}\n"
        f"Error Message: {message}"
        f"{line_part}"
        f"{terminal_part}\n"
        f"Source Code:\n```\n{clean_source[:4000]}\n```"
    )

    try:
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            response_format={"type": "json_object"},
            temperature=0.3,
            max_tokens=600
        )
        
        raw_content = response.choices[0].message.content
        if not raw_content:
            raise ValueError("Empty Groq response")
            
        data = json.loads(raw_content)
        regions_data = data.get("regions", [])
        
        if not isinstance(regions_data, list) or len(regions_data) == 0:
            raise ValueError("Invalid regions format in response")
            
        regions = []
        for r in regions_data:
            start = int(r.get("lineStart", 1))
            end = int(r.get("lineEnd", start))
            meaning = str(r.get("meaning", "Inspect this region for potential logic errors."))
            regions.append(ErrorRegion(lineStart=start, lineEnd=end, meaning=meaning))
            
        return regions[:4]  # cap at 4 regions max
        
    except Exception as e:
        logger.error("Failed to analyze error regions: %s", e)
        return [fallback_region]
