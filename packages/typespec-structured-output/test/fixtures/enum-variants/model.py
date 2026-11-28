from enum import Enum
from typing import Literal, Optional
from pydantic import BaseModel, Field

class Priority(int, Enum):
    low = 1
    mid = 2
    high = 3

class Mode(str, Enum):
    auto = "auto"
    manual = "manual"

class Task(BaseModel):
    priority: Priority
    mode: Mode
    fixed: Literal[Mode.auto]
    either: Literal[Mode.auto, Mode.manual]
    modes: list[Mode]
    override_mode: Optional[Mode] = Field(description="Overridden mode.")

ROOTS = [Task]
