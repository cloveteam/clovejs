import { service } from "clovejs"

export interface Mail {
  to: string
  subject: string
  at: string
}

/** Stands in for an email provider, so the example stays runnable offline. */
export default service(async () => {
  const sent: Mail[] = []

  return {
    send(to: string, subject: string): void {
      sent.push({ to, subject, at: new Date().toISOString() })
    },

    all(): Mail[] {
      return sent
    },
  }
})
