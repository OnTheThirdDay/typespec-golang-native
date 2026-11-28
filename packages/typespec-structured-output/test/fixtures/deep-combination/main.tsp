import "typespec-structured-output";
using StructuredOutput;

/** A geographic point. */
model Point { lat: float64; lon: float64; }
enum Status { open, closed }
model Event<T> {
  /** When it happened. */
  at: utcDateTime;
  payload: T;
  tags: string[];
}
model Venue {
  name: string;
  location: Point | null;
  status: Status;
  sub_venues: Venue[];
}
@structuredOutput
model Timeline {
  events: Event<Venue>[];
  /** The primary venue. */
  primary?: Venue | null;
  status_or_text: Status | string;
}
