export interface Order {
  id: number;
  sku: string;
  quantity: number;
  /** The reservation of the stock, stored with the second write. */
  reservation?: string;
}
