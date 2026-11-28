from typing import Annotated, Optional
from pydantic import BaseModel, Field

class Point(BaseModel):
    x: Annotated[int, Field(ge=-2147483648, le=2147483647)]

class Settings(BaseModel):
    tags: list[str] = Field(default_factory=list)
    origin: Point = Field(default_factory=lambda: Point(x=0))
    retries: Annotated[int, Field(ge=-2147483648, le=2147483647)] = 3
    label: Optional[str] = Field(default_factory=lambda: None)

ROOTS = [Settings]
