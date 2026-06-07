# repository package — data access layer for Zero-Magic missions.
# Import from this package to query the static mission bank.

from .mission_repository import MissionTemplate, get_mission, list_all, register_mission

__all__ = ["MissionTemplate", "get_mission", "list_all", "register_mission"]
