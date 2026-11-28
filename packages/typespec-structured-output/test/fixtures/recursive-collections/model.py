from typing import Annotated, Generic, TypeVar
from typing_extensions import TypeAliasType
from pydantic import BaseModel, Field

Branches = TypeAliasType("Branches", Annotated[list["Branches"], Field(max_length=3)])
Tree = TypeAliasType("Tree", dict[str, "Tree"])

T = TypeVar("T")


class Packet(BaseModel, Generic[T]):
    value: T


class Forest(BaseModel):
    roots: Branches
    short: Annotated[Branches, Field(max_length=1)]
    named: Tree
    packet: Packet[Branches]


ROOTS = [Forest]
