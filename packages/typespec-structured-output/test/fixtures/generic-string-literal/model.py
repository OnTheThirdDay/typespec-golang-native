from typing import Generic, Literal, TypeVar
from pydantic import BaseModel

T = TypeVar("T")
class Box(BaseModel, Generic[T]):
    value: T
class Labels(BaseModel):
    first: Box[Literal["it's here"]]
    second: Box[Literal['tab\t"quote"']]

ROOTS = [Labels]
