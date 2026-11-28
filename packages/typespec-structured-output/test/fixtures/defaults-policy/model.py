from enum import Enum
from typing import Annotated, Optional
from pydantic import BaseModel, Field

class Level(str, Enum):
    info = "info"
    warn = "warn"

class Settings(BaseModel):
    level: Level = Level.warn
    retries: Annotated[int, Field(ge=-2147483648, le=2147483647)] = 3
    label: Optional[str] = "x"
    note: Optional[str] = None
    tags: list[str] = ["a", "b"]

ROOTS = [Settings]
