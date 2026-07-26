import { service } from "clovejs"
import type { OrderCreated } from "../consumers/billing/orderCreated.js"

export interface Invoice {
  invoiceId: string
  orderId: string
  amount: number
}

/**
 * An ordinary singleton service. Consumers resolve services exactly as HTTP
 * handlers do — a delivery gets its own request-scoped container off the same
 * root, so nothing here needs to know it is being called from a message.
 */
export default service(async () => {
  const issued: Invoice[] = []
  let sequence = 0

  return {
    /**
     * Fails on demand, so the retry path is easy to watch: any order for
     * "flaky@example.com" throws until its third delivery.
     */
    async createForOrder(order: OrderCreated): Promise<Invoice> {
      if (order.customer === "flaky@example.com" && attempts(order.orderId) < 3) {
        bump(order.orderId)
        throw new Error(`billing provider timed out for ${order.orderId}`)
      }

      const invoice: Invoice = {
        invoiceId: `inv-${++sequence}`,
        orderId: order.orderId,
        amount: order.total,
      }
      issued.push(invoice)
      return invoice
    },

    all(): Invoice[] {
      return issued
    },
  }
})

// Deliberately module-level, not request state: it has to survive across
// deliveries, since each redelivery gets a fresh container.
const tries = new Map<string, number>()
const attempts = (orderId: string): number => tries.get(orderId) ?? 0
const bump = (orderId: string): void => void tries.set(orderId, attempts(orderId) + 1)
