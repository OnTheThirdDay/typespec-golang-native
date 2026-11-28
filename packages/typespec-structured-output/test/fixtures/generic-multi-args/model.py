from enum import Enum
from typing import Generic, TypeVar
from pydantic import BaseModel

K = TypeVar("K")
V = TypeVar("V")

class Kind(str, Enum):
    a = "a"
    b = "b"

class Item(BaseModel):
    id: str

class Pair(BaseModel, Generic[K, V]):
    key: K
    value: V

class Bag(BaseModel):
    p1: Pair[str, Item]
    p2: Pair[Kind, int]
    p3: Pair[bool, float]

ROOTS = [Bag]
