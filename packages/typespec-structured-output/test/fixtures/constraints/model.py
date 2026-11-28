from typing import Annotated
from pydantic import BaseModel, Field

CurrencyCode = Annotated[str, Field(pattern="^[A-Z]{3}$")]

class Order(BaseModel):
    title: Annotated[str, Field(min_length=1, max_length=40)]
    currency: CurrencyCode
    discount: Annotated[float, Field(ge=0, lt=100)]
    lines: Annotated[list[str], Field(min_length=1, max_length=5)]
    contact: Annotated[str, Field(json_schema_extra={"format": "email"})]

ROOTS = [Order]
