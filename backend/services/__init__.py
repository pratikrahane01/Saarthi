# services package — business logic layer for Zero-Magic backend.
# Import from here to perform mission lookups, hidden-test generation,
# optional LLM enrichment, and context resolution without coupling to FastAPI.

from .mission_service import MissionLookupResult, lookup_mission
from .hidden_test_service import (
    HiddenTestResult,
    HiddenTestGenerationError,
    generate_hidden_test,
    list_registered_generators,
)
from .llm_service import LLMEnrichment, enrich_mission
from . import groq_service
from . import context_service
from .context_service import ResolvedContext, ContextSource, resolve_primary_context, build_groq_context_block

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
    # groq direct access
    "groq_service",
    # context resolution (terminal-aware)
    "context_service",
    "ResolvedContext",
    "ContextSource",
    "resolve_primary_context",
    "build_groq_context_block",
]
