from typing import Annotated, Generic, TypeVar
from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")
Int32 = Annotated[int, Field(ge=-2147483648, le=2147483647)]


class Base(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str


class Reopened(Base):
    """Reopens a closed base with typed extras."""
    model_config = ConfigDict(extra="allow")
    __pydantic_extra__: dict[str, str]


class OpenExtras(BaseModel):
    model_config = ConfigDict(extra="allow")
    __pydantic_extra__: dict[str, str]
    a: str


class ClosedExtras(OpenExtras):
    """Closes a base that allows typed extras."""
    model_config = ConfigDict(extra="forbid")
    b: str


class InheritsExtras(OpenExtras):
    c: str


class SpreadExtras(BaseModel):
    model_config = ConfigDict(extra="allow")
    __pydantic_extra__: dict[str, str]
    id: str


class Box(BaseModel, Generic[T]):
    model_config = ConfigDict(extra="forbid")
    item: T


class Root(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reopened: Reopened
    spread: SpreadExtras
    nested: str | Int32 | None
    closedExtras: ClosedExtras
    inheritsExtras: InheritsExtras
    counts: dict[str, Int32]
    closedMap: dict[str, Base]
    boxedMap: Box[dict[str, str]]
    boxedOpen: Box[OpenExtras]


ROOTS = [Root]
