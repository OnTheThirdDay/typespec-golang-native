# Profile convention: a TypeSpec namespace is the Python module of its declarations.
from pydantic import BaseModel

class Address(BaseModel):
    __module__ = "Billing"
    line: str
BillingAddress = Address

class Address(BaseModel):
    __module__ = "Shipping"
    street: str
    zip: str
ShippingAddress = Address

class Shipment(BaseModel):
    bill_to: BillingAddress
    ship_to: ShippingAddress

ROOTS = [Shipment]
