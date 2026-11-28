namespace Shop.Common {
  /** A page of items. */
  model Page<T> { items: T[]; next?: url; meta: { total: int64 }; }

  model Problem { code: "bad" | "worse"; message: string; ...Record<never>; }
}
