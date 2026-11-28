from typing import Annotated
from pydantic import BaseModel, Field


class Item(BaseModel):
    """An item as it is read back."""

    id: str
    name: str


class Page(BaseModel):
    items: list[Item]
    total: Annotated[int, Field(ge=-2147483648, le=2147483647)]


ROOTS = [Page]
