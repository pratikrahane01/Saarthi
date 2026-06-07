"""
main.py — Zero-Magic FastAPI application entry point.

Start the server with:
    uvicorn backend.main:app --reload --port 8000

The VS Code extension (missions.ts) calls:
    POST http://127.0.0.1:8000/v1/missions/generate-mission

Interactive docs:
    http://127.0.0.1:8000/docs      (Swagger UI)
    http://127.0.0.1:8000/redoc     (ReDoc)
"""

from __future__ import annotations

import logging
import logging.config
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers import missions_router


# ---------------------------------------------------------------------------
# Logging — configure once at startup before any logger is used
# ---------------------------------------------------------------------------

logging.config.dictConfig({
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "format": "%(asctime)s  %(levelname)-8s  %(name)s | %(message)s",
            "datefmt": "%H:%M:%S",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "default",
            "stream": "ext://sys.stdout",
        },
    },
    "root": {
        "level": "INFO",
        "handlers": ["console"],
    },
    # Zero-Magic namespaces at DEBUG so we see every decision during dev
    "loggers": {
        "zero_magic": {
            "level": "DEBUG",
            "handlers": ["console"],
            "propagate": False,
        },
    },
})

logger = logging.getLogger("zero_magic.main")


# ---------------------------------------------------------------------------
# Lifespan — startup / shutdown hooks
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Log startup and shutdown so it is easy to confirm the server is live."""
    logger.info("Zero-Magic Backend starting up…")
    logger.info(
        "Registered routes: %s",
        [r.path for r in app.routes],  # type: ignore[attr-defined]
    )
    yield
    logger.info("Zero-Magic Backend shutting down.")


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Zero-Magic Backend",
    description=(
        "Local micro-service that powers the Zero-Magic VS Code extension. "
        "Accepts compiler error context and returns a Socratic mission with "
        "a hidden unit-test payload."
    ),
    version="0.7.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)


# ---------------------------------------------------------------------------
# CORS — allow the VS Code extension (Node.js fetch) to reach the server.
# In production this would be locked down to a specific origin; during
# local development we allow all origins.
# ---------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten in production
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

app.include_router(missions_router)


# ---------------------------------------------------------------------------
# Health-check routes — lightweight, no database calls, no dependencies
# ---------------------------------------------------------------------------

@app.get(
    "/",
    tags=["health"],
    summary="Root health check",
    description="Human-readable entry point. Confirms the server process is alive.",
)
def root_health_check() -> dict[str, str]:
    return {
        "status": "ok",
        "message": "Zero-Magic Backend is running",
        "version": "0.7.0",
    }


@app.get(
    "/health",
    tags=["health"],
    summary="Monitoring health probe",
    description=(
        "Machine-readable liveness probe. Returns ``{status: ok}`` with no "
        "database calls or heavy work. Suitable for hackathon demo validators, "
        "uptime monitors, and CI smoke tests."
    ),
    status_code=200,
)
def health() -> dict[str, str]:
    """
    Minimal liveness endpoint.

    Intentionally contains zero business logic — if this route fails,
    the process itself is broken, not just a downstream dependency.
    """
    return {
        "status": "ok",
        "service": "zero-magic-backend",
    }
