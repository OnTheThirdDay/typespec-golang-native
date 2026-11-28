from decimal import Decimal
from typing import Annotated, Literal
from pydantic import BaseModel, Field, WithJsonSchema

Padded = Annotated[str, Field(pattern=r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$")]
URLBytes = Annotated[str, Field(pattern=r"^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$")]
class Wire(BaseModel):
    padded: Padded
    url: URLBytes
    flag: Literal["true", "false"]
    amount: Annotated[Decimal, Field(ge=0), WithJsonSchema({"type": "number", "minimum": 0})]

ROOTS = [Wire]
