import "typespec-structured-output";
using StructuredOutput;

model Circle { shape: "circle"; radius: float64; }
model Rect { shape: "rect"; width: float64; height: float64; }
@discriminated(#{ envelope: "none", discriminatorPropertyName: "shape" })
union Shape { circle: Circle, rect: Rect }
@structuredOutput
model Drawing {
  shapes: Shape[];
  primary: Shape | null;
}
