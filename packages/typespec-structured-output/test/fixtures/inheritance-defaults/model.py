from typing import Annotated, Literal
from pydantic import BaseModel, Field

class Base(BaseModel):
    id: str

class Derived(Base):
    score: Annotated[int, Field(ge=-2147483648, le=2147483647)] = 5
    mode: Literal["fast", "slow"] = "fast"

ROOTS = [Derived]
