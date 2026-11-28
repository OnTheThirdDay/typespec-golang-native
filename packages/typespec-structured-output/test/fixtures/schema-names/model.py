# @schemaName is the Pydantic class name; TypeSpec namespaces are Python modules.
from enum import Enum
from typing import Generic, TypeVar
from pydantic import BaseModel

T = TypeVar("T")

class PostalAddress(BaseModel):
    __module__ = "Billing"
    line: str
BillingAddress = PostalAddress

class PostalAddress(BaseModel):
    __module__ = "Shipping"
    street: str
ShippingAddress = PostalAddress

class Tier(str, Enum):
    gold = "gold"
    silver = "silver"

class Envelope(BaseModel, Generic[T]):
    item: T

class Item(BaseModel):
    name: str

class Renamed(BaseModel):
    a: str

class CopyOfOriginal(BaseModel):
    """`is` copies decorators, but the name belongs to the declaration that writes it."""
    a: str

class FriendlyOnly(BaseModel):
    b: str

class Wins(BaseModel):
    c: str

class Order(BaseModel):
    bill: BillingAddress
    ship: ShippingAddress
    level: Tier
    wrapped: Envelope[Item]
    original: Renamed
    duplicate: CopyOfOriginal
    friendly: FriendlyOnly
    both: Wins

class RenamedRoot(BaseModel):
    x: str

ROOTS = [Order, RenamedRoot]
