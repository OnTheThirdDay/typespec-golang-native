from pydantic import BaseModel, ConfigDict, Field

class Empty(BaseModel):
    pass

class custom_name(BaseModel):
    """
    Multi-line
    documentation.
    """
    model_config = ConfigDict(title="Custom Title")
    empty: Empty
    snake_case_name: str
    camelCaseName: str
    x1y2: str
    private_: str = Field(alias="_private")

ROOTS = [custom_name]
