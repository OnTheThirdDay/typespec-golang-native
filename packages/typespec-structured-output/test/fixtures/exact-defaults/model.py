from typing import Literal
from enum import Enum
from pydantic import BaseModel, Field

class Choice(Enum):
    yes = "ok"
    huge = 9007199254740993

class Inner(BaseModel):
    n: int = Field(alias="wire")

class Exact(BaseModel):
    id: Literal[9007199254740993]
    choice: Choice
    instance: Inner = Inner(wire=18446744073709551615)
    values: list[int] = [9007199254740997]

ROOTS = [Exact]
