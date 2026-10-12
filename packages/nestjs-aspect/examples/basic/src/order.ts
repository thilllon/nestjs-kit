export interface Order {
  id: number;
  sku: string;
  quantity: number;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** `pending` until the stock is reserved, `cancelled` when it cannot be. */
  status: "pending" | "confirmed" | "cancelled";
  /** The reservation of the stock, stored when the order is confirmed. */
  reservation?: string;
}

/** A change of an order, stored in the transaction that makes the change. */
export interface OrderEvent {
  id: number;
  type: "order.created" | "order.confirmed" | "order.cancelled";
  orderId: number;
}
