import { get, view } from "clovejs"

/** A web/ page: mounts at the root "/", not under "/api". */
export default get(async () => view("greeting", { name: "root" }))
