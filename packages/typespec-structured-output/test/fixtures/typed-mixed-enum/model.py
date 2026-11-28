from enum import Enum
from typing import Literal, Union
from pydantic import BaseModel

class Choice(Enum):
    red = "red"
    one = 1
    blue = "blue"

    @classmethod
    def __get_pydantic_json_schema__(cls, core_schema, handler):
        schema = handler.resolve_ref_schema(handler(core_schema))
        del schema["enum"]
        schema["anyOf"] = [{"enum": ["red", "blue"], "type": "string"}, {"const": 1, "type": "integer"}]
        return schema

class Selected(BaseModel):
    choice: Choice
    literal: Union[Literal["red", "blue"], Literal[1]]

ROOTS = [Selected]
