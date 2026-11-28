from pydantic import BaseModel, Field

class Profile(BaseModel):
    first_name: str = Field(alias="firstName")
    lastName: str = Field(alias="last-name")
    display_name: str = Field(alias="display name")

ROOTS = [Profile]
