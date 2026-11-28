from typing import Generic, TypeVar
from pydantic import BaseModel, ConfigDict

T = TypeVar("T")


class EmptyRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Box(BaseModel, Generic[T]):
    value: T


class M(BaseModel):
    nothing: EmptyRecord
    items: list[EmptyRecord]
    boxed: Box[EmptyRecord]


ROOTS = [M]
