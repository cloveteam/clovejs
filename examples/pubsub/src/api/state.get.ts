import { get } from "clovejs"

/** Everything the consumers have done so far, in one place. */
export default get(async (_req, _res, ctx) => ({
  invoices: ctx.invoices.all(),
  inbox: ctx.inbox.all(),
  ledger: ctx.ledger.snapshot(),
  deliveries: ctx.deliveryLog.recent(),
}))
