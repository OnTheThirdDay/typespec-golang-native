# option optional-properties: nullable  ->  `a?: T` is declared as `a: T | None = None`
from typing import Annotated, Optional
from pydantic import BaseModel, Field

class Inner(BaseModel):
    v: str

class Partial(BaseModel):
    a: Optional[str] = None
    b: Optional[Inner] = None
    c: Optional[Annotated[str, Field(max_length=3)]] = None

ROOTS = [Partial]
