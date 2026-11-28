from datetime import date
from enum import Enum
from typing import Annotated, Literal, Optional
from pydantic import BaseModel, Field

class Tier(str, Enum):
    free = "free"
    pro = "pro"

Name = Annotated[str, Field(min_length=1)]

class Account(BaseModel):
    id: str
    tier: Tier
    name: Name

class Premium(Account):
    """A premium account."""
    tier: Literal[Tier.pro]
    nickname: Optional[Annotated[str, Field(min_length=1, max_length=10)]] = None
    since: Optional[date] = None
    level: Tier = Tier.pro

ROOTS = [Premium]
