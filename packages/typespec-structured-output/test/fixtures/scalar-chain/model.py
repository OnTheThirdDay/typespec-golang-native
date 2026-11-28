from typing import Annotated, Optional
from pydantic import BaseModel, Field

ShortId = Annotated[str, Field(min_length=3, max_length=10, description="An identifier.")]
Percent = Annotated[float, Field(ge=0)]

class Entity(BaseModel):
    id: ShortId
    code: Annotated[str, Field(min_length=3, max_length=5)] = Field(description="Narrower.")
    ratio: Percent
    bounded: Annotated[float, Field(ge=0, le=100)]
    small: Annotated[int, Field(ge=0, le=255)]
    positive: Annotated[int, Field(gt=0, le=32767)]
    safe: Annotated[int, Field(ge=-9007199254740991, le=9007199254740991)]
    big: Annotated[int, Field(ge=0, le=18446744073709551615)]
    maybe_id: Optional[Annotated[str, Field(min_length=3, max_length=10)]] = Field(description="An identifier.")
    pairs: Annotated[list[list[Annotated[int, Field(ge=-2147483648, le=2147483647)]]], Field(min_length=2)]

ROOTS = [Entity]
