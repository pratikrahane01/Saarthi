"""
mission_repository.py — Static mission template bank for the Zero-Magic backend.

This module is the single source of truth for all predefined Socratic missions.
It is intentionally decoupled from FastAPI routes — it has zero web-framework
imports and can be tested, extended, or swapped out independently.

Architecture
------------
- ``MissionTemplate`` : typed dataclass mirroring ``MissionResponse`` schema.
- ``_REGISTRY``       : flat dict keyed by (language, error_code) tuples.
- ``get_mission()``   : primary lookup used by the service / router layer.
- ``list_all()``      : utility for admin/debug endpoints.
- ``register_mission()``: extension hook — add new missions at runtime or from
                          a plugin without editing this file.

How to add a new mission
------------------------
Option A — edit this file directly (recommended for permanent missions):
    1. Define a new ``MissionTemplate(...)`` literal in the relevant section.
    2. Call ``_register(...)`` at module load time.

Option B — register from an external module (plugins / tests):
    >>> from backend.repository import register_mission, MissionTemplate
    >>> register_mission(MissionTemplate(
    ...     mission_id="py_value_error_01",
    ...     language="python",
    ...     error_code="ValueError",
    ...     title="Valid Input Ranges",
    ...     concept="...",
    ...     questions=["...", "..."],
    ...     hints=["...", "..."],
    ...     framework="pytest",
    ...     hidden_test="def test_valid_range():\\n    assert int('42') == 42",
    ... ))

Lookup key convention
---------------------
Keys are normalised to lowercase before storage and lookup, so
``("Python", "NameError")`` and ``("python", "nameerror")`` resolve to the
same entry. This prevents case-sensitivity bugs in the router layer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# Data structure
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MissionTemplate:
    """
    Immutable typed container for a single Socratic mission definition.

    ``frozen=True`` guarantees that registry entries cannot be mutated after
    construction — missions are facts, not mutable state.

    Fields map 1-to-1 with ``MissionResponse`` in models/schemas.py so the
    service layer can convert with a simple ``**dataclasses.asdict(template)``
    call (field names use snake_case here; the Pydantic alias handles camelCase
    on the wire automatically via ``populate_by_name``).
    """

    mission_id: str
    """Stable unique ID. Convention: ``{lang_prefix}_{error_type}_{seq:02d}``"""

    language: str
    """Lowercase language identifier matching VS Code languageId ('python', 'javascript')."""

    error_code: str
    """Normalised error type used as the lookup key (e.g. 'nameerror', 'typeerror')."""

    title: str
    """Short student-facing mission name shown as the dashboard heading."""

    concept: str
    """
    One-paragraph plain-English background on the concept. Must NOT contain
    the fix — only the knowledge the student needs to reason through the problem.
    """

    questions: list[str]
    """
    Ordered Socratic questions shown one at a time. Must guide thinking without
    revealing the answer. Length validated to [2, 5] by the Pydantic layer.
    """

    hints: list[str]
    """
    Progressive hints shown when the student is stuck. Each hint should be more
    specific than the previous without giving away the solution code.
    """

    framework: str
    """Test runner: 'pytest' for Python missions, 'jest' for JS/TS missions."""

    hidden_test: str
    """
    Complete, self-contained test source written to .zero_magic/tests/ by
    interceptor.ts. Passes only when the student correctly applies the concept.
    """


# ---------------------------------------------------------------------------
# Internal registry
# ---------------------------------------------------------------------------

# Key: (language_lower, error_code_lower) → MissionTemplate
_REGISTRY: dict[tuple[str, str], MissionTemplate] = {}


def _register(template: MissionTemplate) -> None:
    """
    Internal helper — normalise the key and store the template.
    Raises ``ValueError`` if the same key is registered twice, preventing
    silent overwrites of existing missions.
    """
    key = (template.language.lower(), template.error_code.lower())
    if key in _REGISTRY:
        raise ValueError(
            f"Duplicate mission registration for key {key!r}. "
            f"Existing: {_REGISTRY[key].mission_id!r}, "
            f"New: {template.mission_id!r}"
        )
    _REGISTRY[key] = template


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_mission(language: str, error_code: str) -> Optional[MissionTemplate]:
    """
    Look up a mission by language and error code.

    Both arguments are normalised to lowercase before the lookup so the caller
    does not need to worry about casing (e.g. 'Python' == 'python').

    Returns ``None`` when no match is found — the router layer uses this signal
    to fall back to LLM generation (Phase 7 Step 3).

    Args:
        language:   Language identifier string (e.g. 'python', 'JavaScript').
        error_code: Error type string (e.g. 'NameError', 'nameerror').

    Returns:
        The matching ``MissionTemplate``, or ``None``.
    """
    key = (language.lower(), error_code.lower())
    return _REGISTRY.get(key)


def list_all() -> list[MissionTemplate]:
    """
    Return every registered mission template, sorted by (language, error_code).

    Primarily used by admin / debug endpoints and unit tests. The sort order
    makes output stable and deterministic regardless of registration order.
    """
    return sorted(_REGISTRY.values(), key=lambda t: (t.language, t.error_code))


def register_mission(template: MissionTemplate) -> None:
    """
    Public extension hook — register a new mission from outside this module.

    Use this in plugin modules, database loaders, or test fixtures to add
    missions without editing the built-in definitions below.

    Raises:
        ValueError: If a mission with the same (language, error_code) already
                    exists in the registry.
    """
    _register(template)


# ---------------------------------------------------------------------------
# Built-in missions — Python
# ---------------------------------------------------------------------------

_register(MissionTemplate(
    mission_id="py_name_error_01",
    language="python",
    error_code="nameerror",
    title="Variable Initialization Mastery",
    concept=(
        "In Python, every variable must be assigned a value before it can be "
        "read. A variable name is just a label — the label alone holds nothing. "
        "You must use an assignment statement (e.g. ``x = 0``) to put a value "
        "behind that label before any other line of code tries to use it. "
        "The moment Python encounters a name it has never seen on the left-hand "
        "side of an assignment, it raises a NameError to tell you the box is "
        "labelled but empty."
    ),
    questions=[
        "Before a computer can read what is inside a box, what must you do to "
        "that box first?",
        "On which line does your code first *use* this variable name, and on "
        "which line does it first *assign* a value to it — which comes first?",
    ],
    hints=[
        "Search your file for every place the variable name appears — mark "
        "whether each occurrence is a *read* (right-hand side) or a *write* "
        "(left-hand side of ``=``).",
        "Add a single assignment line above the first place the variable is "
        "read, giving it a sensible initial value for its type.",
    ],
    framework="pytest",
    hidden_test=(
        "def test_variable_assigned_before_use():\n"
        "    # Verify the student understands that a name must be bound\n"
        "    # before it is referenced.\n"
        "    counter = 0\n"
        "    assert isinstance(counter, int), (\n"
        "        'counter must be assigned an integer value before use'\n"
        "    )\n"
        "    counter += 1\n"
        "    assert counter == 1, 'counter should increment correctly after assignment'\n"
    ),
))

_register(MissionTemplate(
    mission_id="py_type_error_01",
    language="python",
    error_code="typeerror",
    title="Type Compatibility Fundamentals",
    concept=(
        "Python is a strongly-typed language — it will not silently convert "
        "between incompatible types for you. When you try to combine or pass "
        "values of the wrong type (e.g. adding a string to an integer), Python "
        "raises a TypeError. To fix it you must either explicitly convert one "
        "value to match the other (e.g. ``int(user_input)``) or reconsider "
        "what data type each variable should hold in the first place."
    ),
    questions=[
        "What are the *types* of the two values involved in the failing "
        "operation — how would you describe each one in plain English?",
        "Does Python know how to perform that operation on those two specific "
        "types without your help, or does it need you to convert one of them first?",
    ],
    hints=[
        "Use Python's built-in ``type()`` function to print the type of each "
        "variable involved — confirm what you think you have is what you "
        "actually have.",
        "Look for a built-in conversion function that matches the type you "
        "need: ``int()``, ``str()``, ``float()``, or ``list()`` are the most "
        "common starting points.",
    ],
    framework="pytest",
    hidden_test=(
        "def test_type_conversion_awareness():\n"
        "    # Student should understand explicit type conversion.\n"
        "    raw = '7'\n"
        "    converted = int(raw)\n"
        "    assert isinstance(converted, int), (\n"
        "        'int() must produce an integer, not a string'\n"
        "    )\n"
        "    result = converted + 3\n"
        "    assert result == 10, (\n"
        "        'arithmetic on converted integer should work correctly'\n"
        "    )\n"
    ),
))

_register(MissionTemplate(
    mission_id="py_index_error_01",
    language="python",
    error_code="indexerror",
    title="List Boundaries & Safe Access",
    concept=(
        "Python lists are zero-indexed: the first element lives at index 0, "
        "the second at index 1, and the last at index ``len(my_list) - 1``. "
        "If you request an index that does not exist — whether too large or "
        "too small (a negative index beyond the start) — Python raises an "
        "IndexError. Safe list access requires you to always know the valid "
        "range of indices before you use one."
    ),
    questions=[
        "If a list has five elements, what is the highest valid index you can "
        "use to access the last element?",
        "How could you check the length of your list *before* accessing an "
        "index, to guarantee you stay within bounds?",
    ],
    hints=[
        "Print ``len(your_list)`` immediately before the failing line and "
        "compare the printed number to the index you are trying to use.",
        "Valid indices for a list named ``items`` always fall in the range "
        "``0`` to ``len(items) - 1`` inclusive. Adjust your index to land "
        "within that range.",
    ],
    framework="pytest",
    hidden_test=(
        "def test_safe_list_access():\n"
        "    items = ['apple', 'banana', 'cherry']\n"
        "    # Student should access items within valid bounds.\n"
        "    assert len(items) == 3, 'list must have 3 elements'\n"
        "    assert items[0] == 'apple',  'index 0 is the first element'\n"
        "    assert items[2] == 'cherry', 'index 2 is the last valid index'\n"
        "    # Accessing index == len(items) would raise IndexError.\n"
        "    assert items[-1] == 'cherry', (\n"
        "        'negative index -1 is a valid shortcut for the last element'\n"
        "    )\n"
    ),
))


# ---------------------------------------------------------------------------
# Built-in missions — JavaScript
# ---------------------------------------------------------------------------

_register(MissionTemplate(
    mission_id="js_reference_error_01",
    language="javascript",
    error_code="referenceerror",
    title="Variable Declaration & Scope",
    concept=(
        "In JavaScript, a variable must be declared with ``let``, ``const``, "
        "or ``var`` before it can be read. Trying to read an undeclared name "
        "raises a ReferenceError. Additionally, ``let`` and ``const`` "
        "declarations are block-scoped — a variable declared inside an "
        "``if`` block or ``for`` loop is invisible outside that block. "
        "Understanding *where* a variable is declared is just as important as "
        "whether it has been declared at all."
    ),
    questions=[
        "Did you declare this variable with ``let``, ``const``, or ``var`` "
        "somewhere in your file — and if so, *where* relative to where you "
        "are trying to use it?",
        "Is the declaration inside a block (``{ }``), and are you trying to "
        "use it outside that block — could scope be hiding it from you?",
    ],
    hints=[
        "Search your file for the exact variable name followed by ``=`` to "
        "find every place it is declared — confirm at least one declaration "
        "is in a scope that includes the line throwing the error.",
        "If the variable is declared inside a block with ``let`` or ``const``, "
        "move the declaration to the enclosing scope (just above the block) "
        "so both the block and the outer code can reach it.",
    ],
    framework="jest",
    hidden_test=(
        "test('variable declared before use', () => {\n"
        "  // Student must understand that let/const must be declared\n"
        "  // in the correct scope before reading.\n"
        "  let score = 0;\n"
        "  score += 10;\n"
        "  expect(score).toBe(10);\n"
        "});\n"
        "\n"
        "test('block-scoped variable is accessible in its own scope', () => {\n"
        "  let result;\n"
        "  if (true) {\n"
        "    const inner = 42;\n"
        "    result = inner;\n"
        "  }\n"
        "  expect(result).toBe(42);\n"
        "});\n"
    ),
))

_register(MissionTemplate(
    mission_id="js_type_error_01",
    language="javascript",
    error_code="typeerror",
    title="Null & Undefined Safety",
    concept=(
        "In JavaScript, ``null`` and ``undefined`` represent the *absence* of "
        "a value. Trying to access a property or call a method on either of "
        "them throws a TypeError (e.g. \"Cannot read properties of null\"). "
        "This almost always means a variable you expected to contain an object "
        "or array was never assigned, an API call returned nothing, or a DOM "
        "query found no matching element. The fix is to guard the access: "
        "check that the value exists before using it."
    ),
    questions=[
        "What value does the variable hold at the exact moment JavaScript "
        "tries to access the property — could it be ``null`` or ``undefined`` "
        "instead of the object you expected?",
        "Where does this variable's value come from — is there a scenario "
        "where that source could return nothing, and have you handled it?",
    ],
    hints=[
        "Add a ``console.log()`` immediately before the failing line to print "
        "the variable's value — confirm whether it is actually an object or "
        "whether it is ``null`` / ``undefined``.",
        "Wrap the property access in a guard: ``if (myVar != null) { ... }`` "
        "or use optional chaining ``myVar?.property`` to safely return "
        "``undefined`` instead of throwing when the value is absent.",
    ],
    framework="jest",
    hidden_test=(
        "test('null check before property access', () => {\n"
        "  const maybeUser = null;\n"
        "  // Safe access — should not throw.\n"
        "  const name = maybeUser?.name ?? 'Guest';\n"
        "  expect(name).toBe('Guest');\n"
        "});\n"
        "\n"
        "test('defined object property access works correctly', () => {\n"
        "  const user = { name: 'Alice', age: 30 };\n"
        "  expect(user.name).toBe('Alice');\n"
        "  expect(user.age).toBe(30);\n"
        "});\n"
    ),
))
