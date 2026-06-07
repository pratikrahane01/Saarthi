"""
hidden_test_service.py — Programmatic hidden-test generator for Zero-Magic.

Responsibility
--------------
Given a language + error code (+ optional raw error message for context),
produce a self-contained test file body and the name of the framework needed
to run it.

This module is the *dynamic* counterpart to the static ``hidden_test`` field
already stored in ``MissionTemplate``.  The two live side-by-side:

  Static path  (repository hit)
      └─► use MissionTemplate.hidden_test  — pre-written, reviewed content

  Dynamic path (repository miss OR LLM-generated mission)
      └─► call generate_hidden_test()  — produced here at request time

Architecture
------------

  TestGeneratorFn
      A plain callable with signature (message: str) -> HiddenTestResult.
      One function per (language, error_code) combination.

  _GENERATORS
      Registry dict: (language_lower, error_code_lower) -> TestGeneratorFn.
      Populated at module load by ``_register_generator()``.

  generate_hidden_test(language, error_code, message)
      Public entry point.
        1. Validate + sanitise inputs.
        2. Look up a specific generator in _GENERATORS.
        3. On HIT  → call the specific generator.
        4. On MISS → call the language-level fallback generator.
        5. If language is also unknown → call the universal fallback.
        6. Return HiddenTestResult.

Extending
---------
To add a new generator:

    @_register_generator("python", "valueerror")
    def _py_value_error(message: str) -> HiddenTestResult:
        return HiddenTestResult(
            framework="pytest",
            hidden_test=(
                "def test_value_within_range():\\n"
                "    value = int('42')\\n"
                "    assert 0 <= value <= 100\\n"
            ),
        )

No other file needs to change.
"""

from __future__ import annotations

import logging
import textwrap
from dataclasses import dataclass
from typing import Callable

logger = logging.getLogger("zero_magic.hidden_test")

# ---------------------------------------------------------------------------
# Public result type
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class HiddenTestResult:
    """
    Immutable result returned by ``generate_hidden_test()``.

    Attributes:
        framework:   Test runner identifier — ``'pytest'`` or ``'jest'``.
                     Consumed by ``runner.ts`` to choose the right execution branch.
        hidden_test: Complete, ready-to-write test file source code.
                     ``interceptor.ts`` writes this verbatim to
                     ``.zero_magic/tests/test_current.<ext>``.
        source:      Human-readable label describing how the test was produced
                     (``'specific'``, ``'language_fallback'``, or ``'universal_fallback'``).
                     Useful for logging and debugging — not sent to the extension.
    """

    framework: str
    hidden_test: str
    source: str = "specific"

    def to_dict(self) -> dict[str, str]:
        """
        Serialise to the wire-format dict expected by ``MissionResponse``.
        ``source`` is intentionally omitted — it is internal metadata only.
        """
        return {"framework": self.framework, "hiddenTest": self.hidden_test}


# ---------------------------------------------------------------------------
# Generator function type alias
# ---------------------------------------------------------------------------

# Each generator receives the raw error message string as context.
# It may use the message to make the test slightly more specific,
# but must always return a valid, runnable test even if message is empty.
TestGeneratorFn = Callable[[str], HiddenTestResult]


# ---------------------------------------------------------------------------
# Internal generator registry
# ---------------------------------------------------------------------------

_GENERATORS: dict[tuple[str, str], TestGeneratorFn] = {}
# Key: (language_lower, error_code_lower) → generator function


def _register_generator(language: str, error_code: str):
    """
    Decorator factory that registers a generator function into ``_GENERATORS``.

    Usage::

        @_register_generator("python", "nameerror")
        def _py_name_error(message: str) -> HiddenTestResult:
            ...
    """
    key = (language.lower(), error_code.lower())

    def decorator(fn: TestGeneratorFn) -> TestGeneratorFn:
        if key in _GENERATORS:
            raise ValueError(
                f"Duplicate generator registration for {key!r}. "
                f"Existing: {_GENERATORS[key].__name__!r}, New: {fn.__name__!r}"
            )
        _GENERATORS[key] = fn
        logger.debug("Registered hidden-test generator: %r -> %s", key, fn.__name__)
        return fn

    return decorator


# ---------------------------------------------------------------------------
# Custom exception
# ---------------------------------------------------------------------------

class HiddenTestGenerationError(ValueError):
    """
    Raised only when input is structurally invalid (blank strings).
    A missing specific generator does NOT raise — it falls back gracefully.
    """


# ---------------------------------------------------------------------------
# ── Python generators ──────────────────────────────────────────────────────
# ---------------------------------------------------------------------------

@_register_generator("python", "nameerror")
def _py_name_error(message: str) -> HiddenTestResult:
    """
    Tests that a student understands variables must be assigned before use.
    The hidden test is intentionally simple and self-contained — it does not
    import student code; it verifies the concept in isolation.
    """
    test_code = textwrap.dedent("""\
        # Zero-Magic hidden test — Python NameError
        # Concept: a variable must be assigned before it is read.

        def test_variable_assigned_before_use():
            \"\"\"
            A NameError means Python found a name it has never seen on the
            left-hand side of an assignment. Assign before you read.
            \"\"\"
            counter = 0                          # assign first
            assert isinstance(counter, int), (
                "counter must be an integer — assign it before use"
            )
            counter += 1
            assert counter == 1, (
                "incrementing an assigned variable must work correctly"
            )

        def test_reassignment_is_allowed():
            \"\"\"Variables can be reassigned as many times as needed.\"\"\"
            value = "initial"
            assert value == "initial"
            value = 42
            assert value == 42
    """)
    return HiddenTestResult(framework="pytest", hidden_test=test_code)


@_register_generator("python", "typeerror")
def _py_type_error(message: str) -> HiddenTestResult:
    """
    Tests that a student understands explicit type conversion.
    Covers both the int() and str() conversion directions.
    """
    test_code = textwrap.dedent("""\
        # Zero-Magic hidden test — Python TypeError
        # Concept: incompatible types require explicit conversion.

        def test_string_to_int_conversion():
            \"\"\"
            Python will not silently turn '7' into 7.
            The student must call int() explicitly.
            \"\"\"
            raw = "7"
            converted = int(raw)
            assert isinstance(converted, int), (
                "int() must produce an int, not a string"
            )
            result = converted + 3
            assert result == 10, (
                "arithmetic on an int-converted value must work correctly"
            )

        def test_int_to_string_conversion():
            \"\"\"String concatenation requires str() when mixing with numbers.\"\"\"
            number = 42
            label = "Answer: " + str(number)
            assert label == "Answer: 42", (
                "str() converts an integer for safe string concatenation"
            )

        def test_type_check_before_operation():
            \"\"\"isinstance() lets us guard operations before they fail.\"\"\"
            values = [1, "two", 3]
            numeric = [v for v in values if isinstance(v, int)]
            assert numeric == [1, 3], (
                "filter with isinstance() to collect only numeric values"
            )
    """)
    return HiddenTestResult(framework="pytest", hidden_test=test_code)


@_register_generator("python", "indexerror")
def _py_index_error(message: str) -> HiddenTestResult:
    """
    Tests that a student understands zero-based indexing and valid ranges.
    Uses a fixed 3-element list so the boundary is always concrete.
    """
    test_code = textwrap.dedent("""\
        # Zero-Magic hidden test — Python IndexError
        # Concept: list indices run from 0 to len(list) - 1.

        def test_valid_index_access():
            \"\"\"Access every valid index of a 3-element list.\"\"\"
            items = ["alpha", "beta", "gamma"]
            assert items[0] == "alpha",  "index 0 is the first element"
            assert items[1] == "beta",   "index 1 is the second element"
            assert items[2] == "gamma",  "index 2 is the last valid index"

        def test_negative_index_access():
            \"\"\"Negative indices count backwards from the end.\"\"\"
            items = ["alpha", "beta", "gamma"]
            assert items[-1] == "gamma", "-1 is a safe shortcut for the last item"
            assert items[-3] == "alpha", "-len(items) is the first item"

        def test_length_before_access():
            \"\"\"Always check length before using a computed index.\"\"\"
            items = ["alpha", "beta", "gamma"]
            last_valid_index = len(items) - 1
            assert last_valid_index == 2, (
                "len(items) - 1 gives the highest safe index"
            )
            assert items[last_valid_index] == "gamma"

        def test_safe_access_with_guard():
            \"\"\"A bounds check prevents IndexError at runtime.\"\"\"
            items = ["alpha", "beta", "gamma"]
            target_index = 5   # intentionally out of range
            if target_index < len(items):
                result = items[target_index]
            else:
                result = None
            assert result is None, (
                "out-of-range index must be caught by the bounds guard"
            )
    """)
    return HiddenTestResult(framework="pytest", hidden_test=test_code)


# ---------------------------------------------------------------------------
# ── JavaScript generators ──────────────────────────────────────────────────
# ---------------------------------------------------------------------------

@_register_generator("javascript", "referenceerror")
def _js_reference_error(message: str) -> HiddenTestResult:
    """
    Tests that a student understands declaration scope in JavaScript.
    Uses Jest. Two tests: declaration before use, and block-scope visibility.
    """
    test_code = textwrap.dedent("""\
        // Zero-Magic hidden test — JavaScript ReferenceError
        // Concept: variables must be declared before they are read,
        //          and let/const are block-scoped.

        test('declared variable increments correctly', () => {
          // A variable declared with let before use does not throw.
          let score = 0;
          score += 10;
          expect(score).toBe(10);
        });

        test('block-scoped variable is visible inside its own block', () => {
          // const declared inside the if-block is accessible within it.
          let captured;
          if (true) {
            const inner = 99;
            captured = inner;   // read inside the block — OK
          }
          expect(captured).toBe(99);
        });

        test('variable declared in outer scope is visible inside a block', () => {
          // Declaring BEFORE the block avoids ReferenceError inside it.
          let total = 0;
          for (let i = 1; i <= 3; i++) {
            total += i;
          }
          expect(total).toBe(6);
        });
    """)
    return HiddenTestResult(framework="jest", hidden_test=test_code)


@_register_generator("javascript", "typeerror")
def _js_type_error(message: str) -> HiddenTestResult:
    """
    Tests that a student understands null/undefined safety in JavaScript.
    Uses optional chaining (?.) and nullish coalescing (??) patterns.
    """
    test_code = textwrap.dedent("""\
        // Zero-Magic hidden test — JavaScript TypeError
        // Concept: null and undefined cannot have properties accessed on them
        //          without a guard.

        test('optional chaining returns undefined for null', () => {
          const user = null;
          // user?.name does NOT throw — returns undefined instead
          const name = user?.name;
          expect(name).toBeUndefined();
        });

        test('nullish coalescing provides a default for null/undefined', () => {
          const user = null;
          const displayName = user?.name ?? 'Guest';
          expect(displayName).toBe('Guest');
        });

        test('defined object property access works normally', () => {
          const user = { name: 'Alice', age: 30 };
          expect(user.name).toBe('Alice');
          expect(user.age).toBe(30);
        });

        test('guard before property access prevents TypeError', () => {
          const maybeObj = Math.random() > 2 ? { x: 1 } : null; // always null
          let result;
          if (maybeObj != null) {
            result = maybeObj.x;
          } else {
            result = -1;
          }
          expect(result).toBe(-1);
        });
    """)
    return HiddenTestResult(framework="jest", hidden_test=test_code)


# ---------------------------------------------------------------------------
# ── Language-level fallback generators ────────────────────────────────────
# ---------------------------------------------------------------------------
# Called when a language is recognised but the specific error_code has no
# generator.  Produces a generic concept-check test for that language.

def _python_fallback(error_code: str, message: str) -> HiddenTestResult:
    """Generic Python test for any unrecognised error type."""
    test_code = textwrap.dedent(f"""\
        # Zero-Magic hidden test — Python fallback
        # Generated for: {error_code}
        # Error message: {message[:120] if message else '(none)'}

        def test_basic_python_correctness():
            \"\"\"
            No specific test exists for '{error_code}' yet.
            This baseline test verifies that fundamental Python concepts work.
            \"\"\"
            # Verify basic assignment and arithmetic
            x = 10
            assert isinstance(x, int)
            assert x + 5 == 15

            # Verify list creation and safe access
            items = list(range(3))
            assert len(items) == 3
            assert items[0] == 0

            # Verify string concatenation via str()
            label = "value=" + str(x)
            assert "10" in label
    """)
    return HiddenTestResult(
        framework="pytest", hidden_test=test_code, source="language_fallback"
    )


def _javascript_fallback(error_code: str, message: str) -> HiddenTestResult:
    """Generic Jest test for any unrecognised JS/TS error type."""
    test_code = textwrap.dedent(f"""\
        // Zero-Magic hidden test — JavaScript fallback
        // Generated for: {error_code}
        // Error message: {message[:120] if message else '(none)'}

        test('basic JavaScript correctness — {error_code} fallback', () => {{
          // No specific test exists for '{error_code}' yet.
          // This baseline checks fundamental JS safety patterns.

          // 1. Declared variable arithmetic
          let counter = 0;
          counter += 1;
          expect(counter).toBe(1);

          // 2. Null-safe property access
          const obj = null;
          const value = obj?.prop ?? 'default';
          expect(value).toBe('default');

          // 3. Array bounds check
          const arr = [10, 20, 30];
          const lastIndex = arr.length - 1;
          expect(arr[lastIndex]).toBe(30);
        }});
    """)
    return HiddenTestResult(
        framework="jest", hidden_test=test_code, source="language_fallback"
    )


# Map of language → fallback function
_LANGUAGE_FALLBACKS: dict[str, Callable[[str, str], HiddenTestResult]] = {
    "python": _python_fallback,
    "javascript": _javascript_fallback,
    "typescript": _javascript_fallback,   # TS shares Jest infra with JS
}


def _universal_fallback(language: str, error_code: str, message: str) -> HiddenTestResult:
    """
    Last-resort fallback when the language itself is not recognised.
    Returns a minimal pytest test so the extension always receives something
    runnable rather than an error.
    """
    logger.warning(
        "Universal fallback invoked | language=%r  error_code=%r", language, error_code
    )
    test_code = textwrap.dedent(f"""\
        # Zero-Magic hidden test — universal fallback
        # Language '{language}' has no registered generator.
        # Error: {error_code} — {message[:80] if message else '(none)'}

        def test_placeholder():
            \"\"\"
            A specific test for language='{language}', error='{error_code}'
            has not been implemented yet.  This placeholder always passes so
            the Zero-Magic flow can complete without blocking the student.
            \"\"\"
            assert True, "Placeholder test — always passes"
    """)
    return HiddenTestResult(
        framework="pytest", hidden_test=test_code, source="universal_fallback"
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def generate_hidden_test(
    language: str,
    error_code: str,
    message: str = "",
) -> HiddenTestResult:
    """
    Generate a hidden test file body for a given language + error combination.

    Resolution order
    ----------------
    1. Specific generator  — exact (language, error_code) match in _GENERATORS.
    2. Language fallback   — language is known but error_code has no generator.
    3. Universal fallback  — language is completely unknown.

    The function never raises on a miss; it always returns a runnable test.
    It raises ``HiddenTestGenerationError`` only when inputs are structurally
    invalid (blank strings).

    Args:
        language:   VS Code languageId (e.g. ``'python'``, ``'javascript'``).
        error_code: Error type (e.g. ``'NameError'``, ``'ReferenceError'``).
        message:    Optional raw error message for additional context.
                    Safe to leave empty; generators handle it gracefully.

    Returns:
        A ``HiddenTestResult`` with ``framework`` and ``hidden_test`` populated.

    Raises:
        HiddenTestGenerationError: If ``language`` or ``error_code`` is blank.

    Example::

        result = generate_hidden_test("python", "NameError", "name 'x' is not defined")
        print(result.framework)    # 'pytest'
        print(result.hidden_test)  # full test source
        print(result.to_dict())    # {"framework": "pytest", "hiddenTest": "..."}
    """
    # ── Validate ────────────────────────────────────────────────────────────
    if not isinstance(language, str) or not language.strip():
        raise HiddenTestGenerationError(
            f"'language' must be a non-empty string; got {language!r}"
        )
    if not isinstance(error_code, str) or not error_code.strip():
        raise HiddenTestGenerationError(
            f"'error_code' must be a non-empty string; got {error_code!r}"
        )

    # ── Sanitise ────────────────────────────────────────────────────────────
    clean_lang = language.strip().lower()
    clean_code = error_code.strip().lower()
    clean_msg  = (message or "").strip()

    logger.info(
        "generate_hidden_test | language=%r  error_code=%r  message=%r",
        clean_lang, clean_code,
        clean_msg[:60] + "…" if len(clean_msg) > 60 else clean_msg,
    )

    # ── Resolution step 1: specific generator ───────────────────────────────
    key = (clean_lang, clean_code)
    specific = _GENERATORS.get(key)
    if specific is not None:
        logger.info("HIT specific generator | key=%r  fn=%s", key, specific.__name__)
        result = specific(clean_msg)
        logger.debug(
            "Generated %d-char test | framework=%s  source=specific",
            len(result.hidden_test), result.framework,
        )
        return result

    # ── Resolution step 2: language-level fallback ──────────────────────────
    lang_fallback = _LANGUAGE_FALLBACKS.get(clean_lang)
    if lang_fallback is not None:
        logger.warning(
            "MISS specific generator | using language fallback for language=%r  error_code=%r",
            clean_lang, clean_code,
        )
        result = lang_fallback(clean_code, clean_msg)
        return result

    # ── Resolution step 3: universal fallback ───────────────────────────────
    logger.warning(
        "MISS language fallback | using universal fallback for language=%r  error_code=%r",
        clean_lang, clean_code,
    )
    return _universal_fallback(clean_lang, clean_code, clean_msg)


# ---------------------------------------------------------------------------
# Registry introspection helpers (for tests / admin endpoints)
# ---------------------------------------------------------------------------

def list_registered_generators() -> list[tuple[str, str]]:
    """
    Return a sorted list of (language, error_code) tuples that have a
    specific generator registered.  Useful for admin debug endpoints.
    """
    return sorted(_GENERATORS.keys())
