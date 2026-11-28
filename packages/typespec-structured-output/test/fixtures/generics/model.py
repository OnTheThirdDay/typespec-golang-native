from typing import Generic, Optional, TypeVar
from pydantic import BaseModel

T = TypeVar("T")

class Item(BaseModel):
    name: str

class Page(BaseModel, Generic[T]):
    items: list[T]
    next_link: Optional[str]

class Catalog(BaseModel):
    first: Page[Item]
    nested: Page[Page[Item]]
    words: Page[str]

ROOTS = [Catalog]
