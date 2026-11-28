from enum import Enum
from typing import Literal, Optional
from pydantic import BaseModel


class Choice(Enum):
    """An enum whose members mix string and integer values."""

    yes = "ok"
    n = 1


class M(BaseModel):
    choice: Choice
    lit: Literal["a", 1]
    withNull: Optional[Literal["b", 2]]


ROOTS = [M]
