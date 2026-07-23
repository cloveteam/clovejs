import { service } from "clovejs"

export default service(() => {
  let executions = 0
  let value = "initial"

  return {
    async read(language = "none") {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { value, language, execution: ++executions }
    },
    write(next: string) {
      value = next
      return { value }
    },
  }
})
