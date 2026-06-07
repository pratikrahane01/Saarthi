# services package — business logic layer for Zero-Magic backend.
# Import from here to perform mission lookups, hidden-test generation,
# and optional LLM enrichment without coupling to FastAPI.

from .mission_service import MissionLookupResult, lookup_mission
from .hidden_test_service import (
    HiddenTestResult,
    HiddenTestGenerationError,
    generate_hidden_test,
    list_registered_generators,
)
from .llm_service import LLMEnrichment, enrich_mission

__all__ = [
    # mission lookup
    "MissionLookupResult",
    "lookup_mission",
    # hidden test generation
    "HiddenTestResult",
    "HiddenTestGenerationError",
    "generate_hidden_test",
    "list_registered_generators",
    # optional LLM enrichment
    "LLMEnrichment",
    "enrich_mission",
]
