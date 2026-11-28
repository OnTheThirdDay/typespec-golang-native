from datetime import date, datetime, time, timedelta
from pydantic import BaseModel

class Primitives(BaseModel):
    text: str
    flag: bool
    count: int
    ratio: float
    created: datetime
    day: date
    at: time
    span: timedelta

ROOTS = [Primitives]
