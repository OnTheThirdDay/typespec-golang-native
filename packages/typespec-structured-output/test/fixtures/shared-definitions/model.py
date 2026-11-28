from pydantic import BaseModel, Field

class Money(BaseModel):
    amount: float
    currency: str

class Line(BaseModel):
    price: Money
    total: Money

class Invoice(BaseModel):
    lines: list[Line]
    subtotal: Money
    total: Money = Field(description="Grand total.")

ROOTS = [Invoice]
