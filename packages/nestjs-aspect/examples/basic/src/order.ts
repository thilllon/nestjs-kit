export interface Order {
  id: number;
  sku: string;
  quantity: number;
  /** Set once the inventory service has reserved the stock. */
  reservation?: string;
}
