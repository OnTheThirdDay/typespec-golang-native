from pydantic import BaseModel, Field
from typing import Generic, TypeVar, Annotated
T = TypeVar("T")

class Box(BaseModel, Generic[T]):
    v: T

class M(BaseModel):
    b: Box[Annotated[int, Field(ge=-2147483648, le=2147483647)]]
    tags: Box[list[str]]

ROOTS = [M]
