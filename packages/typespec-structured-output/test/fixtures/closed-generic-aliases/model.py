from typing import Generic, TypeVar
from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class Cell(BaseModel, Generic[T]):
    model_config = ConfigDict(extra="forbid")
    value: T


class Group(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first: Cell[str] = Field(alias="10")
    second: Cell[bool] | None = Field(alias="2")
    descendants: list["Group"] = Field(max_length=2)


class Index(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group: Group
    annotation: str | None = None


class Measurements(BaseModel):
    cell: Cell[float]


ROOTS = [Index, Measurements]
