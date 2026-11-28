namespace Shop.Orders {
  model Order { id: string; lines: Line[]; total?: Common.Money; status: "open" | "paid" | string; }
  model Line { product: string; quantity: int32; }
  model OrderList { orders: Common.Page<Order>; names?: Common.Page<string>; }

  namespace Archive {
    /** Same name as Shop.Orders.Order: qualified in Go. */
    model Order { id: string; archivedAt: utcDateTime; }
  }
}

// `foo_bar` in both cases: the file names are numbered.
namespace Shop.FooBar { model A { a: string; } }
namespace Shop.Foo_Bar { model B { b: string; } }

// Names that would carry build constraints or test semantics as plain Go file names.
namespace Shop.Linux_Amd64 { model C { c: string; } }
namespace Shop.Windows_Amd64 { model D { d: string; } }
namespace Shop.Js { model E { e: string; } }
