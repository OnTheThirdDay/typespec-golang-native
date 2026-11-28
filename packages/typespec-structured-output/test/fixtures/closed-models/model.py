from typing import Annotated, Generic, TypeVar
from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class Closed(BaseModel):
    """A closed model."""
    model_config = ConfigDict(extra="forbid")
    name: str


class Base(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str


class DerivedFromClosed(Base):
    """Inherits the closure of its base, as Pydantic subclasses inherit model_config."""


class Open(BaseModel):
    name: str


class ClosedFromOpen(Open):
    model_config = ConfigDict(extra="forbid")
    extra: Annotated[int, Field(ge=-2147483648, le=2147483647)]


class SpreadOfClosed(BaseModel):
    """A spread copies the properties and the indexer, so the copy is closed too."""
    model_config = ConfigDict(extra="forbid")
    name: str
    more: str


class Gen(BaseModel, Generic[T]):
    model_config = ConfigDict(extra="forbid")
    value: T


class Tree(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str
    kids: list["Tree"]


class Empty(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Root(BaseModel):
    model_config = ConfigDict(extra="forbid")
    closed: Closed
    derived: DerivedFromClosed
    closedFromOpen: ClosedFromOpen
    spread: SpreadOfClosed
    gen: Gen[str]
    genClosed: Gen[Closed]
    tree: Tree
    empty: Empty
    open: Open
    maybe: Closed | None
    many: list[Closed]




ROOTS = [Root, Tree]
