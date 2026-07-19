import { di } from "clovejs"

export default di({
  lifetime: "singleton",
  value: {
    url: process.env.URL ?? "http://localhost:3000",
    db: {
      user: process.env.DB_USER ?? "clove",
      password: process.env.DB_PASSWORD ?? "secret",
    },
  },
})
