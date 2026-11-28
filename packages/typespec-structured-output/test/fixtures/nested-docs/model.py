from pydantic import BaseModel, Field

class Address(BaseModel):
    """A postal address."""
    street: str = Field(description="Street line.")
    city: str

class Customer(BaseModel):
    """A customer record."""
    home: Address = Field(description="Where the customer lives.")
    work: Address
    display_name: str = Field(title="Display Name")

ROOTS = [Customer]
