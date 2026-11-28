from typing import Optional, Union

from pydantic import BaseModel, Field
from typing_extensions import TypeAliasType

Json = TypeAliasType("Json", Union[str, float, bool, list["Json"], dict[str, "Json"], None])
A = TypeAliasType("A", Union[str, list["B"]])
B = TypeAliasType("B", Union[bool, list["A"]])


class Node(BaseModel):
    label: str
    next: Optional["Chain"]


Chain = Union[Node, str]


class Doc(BaseModel):
    value: Json = Field(description="The payload.")
    pair: A
    chain: Chain
    list: list[Json]
    maybe: Optional[B]


ROOTS = [Doc]
