from typing import Annotated, Generic, TypeVar, Union

from pydantic import BaseModel, Field
from typing_extensions import TypeAliasType

T = TypeVar("T")
Tree = TypeAliasType("Tree", Union[str, list["Tree"]])


class Box(BaseModel, Generic[T]):
    v: T


class Holder(BaseModel):
    b: Box[Tree]
    plain: Box[Union[str, Annotated[int, Field(ge=-2147483648, le=2147483647)]]]


ROOTS = [Holder]
