from typing import Annotated, Any
from pydantic import AnyUrl, BaseModel, ConfigDict, Field

class Extra(BaseModel):
    model_config = ConfigDict(extra="allow")
    __pydantic_extra__: dict[str, Annotated[int, Field(ge=-2147483648, le=2147483647)]]
    name: str

class Loose(BaseModel):
    counts: dict[str, int]
    pair: tuple[str, int]
    extra: Extra
    anything: Any
    link: AnyUrl

ROOTS = [Loose]
